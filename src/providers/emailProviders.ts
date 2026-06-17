import { connect as connectTls } from "node:tls";
import type {
  RAGEmailSyncAttachment,
  RAGEmailSyncClient,
  RAGEmailSyncListInput,
  RAGEmailSyncListResult,
  RAGEmailSyncMessage,
  RAGGmailLinkedEmailSyncClientOptions,
} from "../../types/engine";
import type {
  GmailEmailSyncConfig,
  GraphEmailSyncConfig,
  IMAPEmailSyncConfig,
} from "../../types/providers";

type FetchLike = (
  ...args: Parameters<typeof fetch>
) => ReturnType<typeof fetch>;

const defaultFetch: FetchLike = (...args) => fetch(...args);

const stripHtml = (value: string) =>
  value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

const decodeBase64Url = (value: string) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding =
    normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));

  return Buffer.from(normalized + padding, "base64");
};

const firstHeader = (
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string,
) =>
  headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())
    ?.value;

type GmailPayload = {
  body?: { data?: string; attachmentId?: string };
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  mimeType?: string;
  partId?: string;
  parts?: GmailPayload[];
};

const collectGmailPayloadParts = (
  payload: GmailPayload | undefined,
): GmailPayload[] => {
  if (!payload) {
    return [];
  }

  return [
    payload,
    ...(payload.parts ?? []).flatMap((part) => collectGmailPayloadParts(part)),
  ];
};

const extractGmailBodyText = (payload: GmailPayload | undefined) => {
  const parts = collectGmailPayloadParts(payload);
  const plain = parts.find(
    (part) => part.mimeType?.toLowerCase() === "text/plain" && part.body?.data,
  );
  if (plain?.body?.data) {
    return decodeBase64Url(plain.body.data).toString("utf8");
  }

  const html = parts.find(
    (part) => part.mimeType?.toLowerCase() === "text/html" && part.body?.data,
  );
  if (html?.body?.data) {
    return stripHtml(decodeBase64Url(html.body.data).toString("utf8"));
  }

  if (payload?.body?.data) {
    return decodeBase64Url(payload.body.data).toString("utf8");
  }

  return "";
};

const toGraphAddressList = (
  value: Array<{ emailAddress?: { address?: string } }> | undefined,
) =>
  value?.map((entry) => entry.emailAddress?.address).filter(Boolean) as
    | string[]
    | undefined;

const toGraphAttachment = (attachment: {
  id?: string;
  name?: string;
  contentType?: string;
  contentBytes?: string;
}) =>
  attachment.name && attachment.contentBytes
    ? ({
        content: attachment.contentBytes,
        contentType: attachment.contentType,
        encoding: "base64",
        id: attachment.id,
        name: attachment.name,
      } satisfies RAGEmailSyncAttachment)
    : null;

const buildGraphPath = (config: GraphEmailSyncConfig) => {
  const base =
    config.userId && config.userId !== "me"
      ? `/users/${encodeURIComponent(config.userId)}`
      : "/me";

  return config.folderId
    ? `${base}/mailFolders/${encodeURIComponent(config.folderId)}/messages`
    : `${base}/messages`;
};

const parseRawEmail = (raw: string): RAGEmailSyncMessage => {
  const [headerBlock, ...bodyBlocks] = raw.split(/\r?\n\r?\n/);
  const body = bodyBlocks.join("\n\n").trim();
  const lines = (headerBlock ?? "").split(/\r?\n/);
  const headers = new Map<string, string>();
  let current = "";

  for (const line of lines) {
    if (/^\s/.test(line) && current) {
      headers.set(
        current,
        `${headers.get(current) ?? ""} ${line.trim()}`.trim(),
      );
      continue;
    }

    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }

    current = line.slice(0, separator).trim().toLowerCase();
    headers.set(current, line.slice(separator + 1).trim());
  }

  const toList = (value: string | undefined) =>
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

  return {
    bodyText: body,
    cc: toList(headers.get("cc")),
    from: headers.get("from"),
    id:
      headers.get("message-id") ??
      headers.get("subject") ??
      crypto.randomUUID(),
    receivedAt: headers.get("date"),
    subject: headers.get("subject"),
    threadId:
      headers.get("thread-topic") ??
      headers.get("references") ??
      headers.get("subject"),
    to: toList(headers.get("to")),
  };
};

const DEFAULT_GMAIL_READONLY_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
];

const GMAIL_MAX_RETRY_ATTEMPTS = 2;
const GMAIL_BASE_RETRY_DELAY_MS = 500;

type GmailErrorBody = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{
      domain?: string;
      message?: string;
      reason?: string;
    }>;
  };
};

type GraphErrorBody = {
  error?: {
    code?: string;
    message?: string;
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getRetryDelayMs = (response: Response, attempt: number) => {
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfterHeader
    ? Number(retryAfterHeader)
    : Number.NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }

  return GMAIL_BASE_RETRY_DELAY_MS * 2 ** attempt;
};

const readGmailError = async (response: Response) => {
  let reason: string | undefined;
  let detailMessage: string | undefined;

  try {
    const body = (await response.clone().json()) as GmailErrorBody;
    reason = body.error?.errors?.[0]?.reason;
    detailMessage = body.error?.errors?.[0]?.message ?? body.error?.message;
  } catch {
    const text = await response.clone().text();
    detailMessage = text.trim().length > 0 ? text.trim() : undefined;
  }

  return { detailMessage, reason };
};

const createGmailHttpError = async (label: string, response: Response) => {
  const { detailMessage, reason } = await readGmailError(response);
  const suffix = [reason, detailMessage]
    .filter(
      (value, index, values) =>
        typeof value === "string" &&
        value.length > 0 &&
        values.indexOf(value) === index,
    )
    .join(" | ");

  return new Error(
    `${label}: ${response.status} ${response.statusText}${suffix ? ` (${suffix})` : ""}`,
  );
};

const readGraphErrorDetail = async (response: Response) => {
  try {
    const body = (await response.clone().json()) as GraphErrorBody;
    const parts = [body.error?.code, body.error?.message].filter(
      (value, index, values): value is string =>
        typeof value === "string" &&
        value.length > 0 &&
        values.indexOf(value) === index,
    );
    if (parts.length > 0) {
      return parts.join(" | ");
    }
  } catch {
    const text = await response
      .clone()
      .text()
      .catch(() => "");
    return text.trim().length > 0 ? text.trim() : undefined;
  }

  return undefined;
};

const fetchGmailWithRetry = async (
  fetchImpl: FetchLike,
  url: URL,
  init: RequestInit,
  label: string,
) => {
  for (let attempt = 0; attempt <= GMAIL_MAX_RETRY_ATTEMPTS; attempt += 1) {
    const response = await fetchImpl(url, init);
    if (response.ok) {
      return response;
    }

    if (response.status === 429 && attempt < GMAIL_MAX_RETRY_ATTEMPTS) {
      await sleep(getRetryDelayMs(response, attempt));
      continue;
    }

    throw await createGmailHttpError(label, response);
  }

  throw new Error(`${label}: retry budget exhausted`);
};

const inferLinkedProviderFailureCode = (
  error: unknown,
):
  | "unauthorized"
  | "insufficient_scope"
  | "provider_error"
  | "rate_limited" => {
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");

  if (/\b401\b/.test(message)) {
    return "unauthorized";
  }

  if (/\b429\b|too many requests|rate.?limit/i.test(message)) {
    return "rate_limited";
  }

  if (/accessnotconfigured|service_disabled|permission_denied/i.test(message)) {
    return "provider_error";
  }

  if (/\b403\b|insufficientpermissions|insufficient_scope/i.test(message)) {
    return "insufficient_scope";
  }

  return "provider_error";
};

export const createRAGGmailEmailSyncClient = (
  config: GmailEmailSyncConfig,
): RAGEmailSyncClient => ({
  listMessages: async (
    input?: RAGEmailSyncListInput,
  ): Promise<RAGEmailSyncListResult> => {
    const fetchImpl = config.fetch ?? defaultFetch;
    const userId = config.userId ?? "me";
    const listUrl = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userId)}/messages`,
    );
    listUrl.searchParams.set(
      "maxResults",
      String(input?.maxResults ?? config.maxResults ?? 100),
    );
    if (input?.cursor) {
      listUrl.searchParams.set("pageToken", input.cursor);
    }
    if (config.query) {
      listUrl.searchParams.set("q", config.query);
    }
    for (const labelId of config.labelIds ?? []) {
      listUrl.searchParams.append("labelIds", labelId);
    }
    if (config.includeSpamTrash) {
      listUrl.searchParams.set("includeSpamTrash", "true");
    }

    const listResponse = await fetchGmailWithRetry(
      fetchImpl,
      listUrl,
      {
        headers: { Authorization: `Bearer ${config.accessToken}` },
      },
      "Gmail list failed",
    );

    const listJson = (await listResponse.json()) as {
      messages?: Array<{ id: string; threadId?: string }>;
      nextPageToken?: string;
    };

    const messages = await Promise.all(
      (listJson.messages ?? []).map(async (messageRef) => {
        const getUrl = new URL(
          `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageRef.id)}`,
        );
        getUrl.searchParams.set("format", "full");
        const response = await fetchGmailWithRetry(
          fetchImpl,
          getUrl,
          {
            headers: { Authorization: `Bearer ${config.accessToken}` },
          },
          `Gmail get failed for ${messageRef.id}`,
        );

        const json = (await response.json()) as {
          id: string;
          threadId?: string;
          internalDate?: string;
          labelIds?: string[];
          payload?: GmailPayload;
          snippet?: string;
        };

        const attachments = await Promise.all(
          collectGmailPayloadParts(json.payload)
            .filter((part) => !!part.filename && !!part.body?.attachmentId)
            .map(async (part) => {
              const attachmentUrl = new URL(
                `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(json.id)}/attachments/${encodeURIComponent(part.body?.attachmentId ?? "")}`,
              );
              const attachmentResponse = await fetchGmailWithRetry(
                fetchImpl,
                attachmentUrl,
                {
                  headers: {
                    Authorization: `Bearer ${config.accessToken}`,
                  },
                },
                `Gmail attachment get failed for ${json.id}:${part.body?.attachmentId ?? "attachment"}`,
              );

              const attachmentJson = (await attachmentResponse.json()) as {
                data?: string;
              };
              if (!attachmentJson.data || !part.filename) {
                return null;
              }

              return {
                content: decodeBase64Url(attachmentJson.data).toString(
                  "base64",
                ),
                contentType: part.mimeType,
                encoding: "base64",
                id: part.body?.attachmentId,
                name: part.filename,
              } satisfies RAGEmailSyncAttachment;
            }),
        );

        return {
          attachments: attachments.filter(Boolean) as RAGEmailSyncAttachment[],
          bodyText: extractGmailBodyText(json.payload) || json.snippet || "",
          cc: firstHeader(json.payload?.headers, "Cc")
            ?.split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
          from: firstHeader(json.payload?.headers, "From"),
          id: json.id,
          metadata: {
            gmailLabelIds: json.labelIds,
            provider: "gmail",
          },
          receivedAt: json.internalDate ? Number(json.internalDate) : undefined,
          subject: firstHeader(json.payload?.headers, "Subject"),
          threadId: json.threadId ?? messageRef.threadId,
          to: firstHeader(json.payload?.headers, "To")
            ?.split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        } satisfies RAGEmailSyncMessage;
      }),
    );

    return {
      messages,
      nextCursor: listJson.nextPageToken,
    };
  },
});

export const createRAGLinkedGmailEmailSyncClient = (
  config: RAGGmailLinkedEmailSyncClientOptions,
): RAGEmailSyncClient => ({
  listMessages: async (
    input?: RAGEmailSyncListInput,
  ): Promise<RAGEmailSyncListResult> => {
    const credential = await config.resolver.resolveCredential({
      bindingId: config.bindingId,
      connectorProvider: "gmail",
      externalAccountId: config.externalAccountId,
      ownerRef: config.ownerRef,
      purpose: config.purpose ?? "background_sync",
      requiredScopes: config.requiredScopes ?? DEFAULT_GMAIL_READONLY_SCOPES,
    });

    if (!credential) {
      throw new Error("No linked Gmail credential could be resolved");
    }

    try {
      const lease = await config.resolver.getAccessToken(credential, {
        minValidityMs: config.minValidityMs,
        requiredScopes: config.requiredScopes ?? DEFAULT_GMAIL_READONLY_SCOPES,
      });

      return await createRAGGmailEmailSyncClient({
        accessToken: lease.accessToken,
        fetch: config.fetch,
        includeSpamTrash: config.includeSpamTrash,
        labelIds: config.labelIds,
        maxResults: config.maxResults,
        query: config.query,
        userId: config.userId,
      }).listMessages(input);
    } catch (error) {
      await config.resolver.reportFailure(credential, {
        code: inferLinkedProviderFailureCode(error),
        message:
          error instanceof Error
            ? error.message
            : String(error ?? "Unknown error"),
      });
      throw error;
    }
  },
});

export const createRAGGraphEmailSyncClient = (
  config: GraphEmailSyncConfig,
): RAGEmailSyncClient => ({
  listMessages: async (
    input?: RAGEmailSyncListInput,
  ): Promise<RAGEmailSyncListResult> => {
    const fetchImpl = config.fetch ?? defaultFetch;
    const url = new URL(
      `${config.baseUrl ?? "https://graph.microsoft.com/v1.0"}${buildGraphPath(config)}`,
    );
    url.searchParams.set(
      "$select",
      "id,conversationId,subject,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,body,hasAttachments,internetMessageId",
    );
    url.searchParams.set(
      "$top",
      String(input?.maxResults ?? config.top ?? 100),
    );
    if (config.filter) {
      url.searchParams.set("$filter", config.filter);
    }
    if (config.search) {
      url.searchParams.set("$search", config.search);
    }
    if (input?.cursor) {
      return {
        messages: [],
        nextCursor: input.cursor,
      };
    }

    const listResponse = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        Prefer: 'outlook.body-content-type="text"',
      },
    });
    if (!listResponse.ok) {
      const detail = await readGraphErrorDetail(listResponse);
      throw new Error(
        `Graph message list failed: ${listResponse.status} ${listResponse.statusText}${detail ? ` (${detail})` : ""}`,
      );
    }

    const listJson = (await listResponse.json()) as {
      value?: Array<Record<string, unknown>>;
      "@odata.nextLink"?: string;
    };

    const messages = await Promise.all(
      (listJson.value ?? []).map(async (message) => {
        const attachments =
          message.hasAttachments === true
            ? await (async () => {
                const attachmentsResponse = await fetchImpl(
                  `${config.baseUrl ?? "https://graph.microsoft.com/v1.0"}${buildGraphPath(config)}/${encodeURIComponent(String(message.id))}/attachments`,
                  {
                    headers: {
                      Authorization: `Bearer ${config.accessToken}`,
                    },
                  },
                );
                if (!attachmentsResponse.ok) {
                  return [] as RAGEmailSyncAttachment[];
                }

                const attachmentsJson = (await attachmentsResponse.json()) as {
                  value?: Array<{
                    id?: string;
                    name?: string;
                    contentType?: string;
                    contentBytes?: string;
                  }>;
                };

                return (attachmentsJson.value ?? [])
                  .map((attachment) => toGraphAttachment(attachment))
                  .filter(Boolean) as RAGEmailSyncAttachment[];
              })()
            : [];

        return {
          attachments,
          bodyText:
            typeof (message.body as { content?: unknown })?.content === "string"
              ? String((message.body as { content?: string }).content)
              : "",
          cc: toGraphAddressList(
            message.ccRecipients as Array<{
              emailAddress?: { address?: string };
            }>,
          ),
          from: (message.from as { emailAddress?: { address?: string } })
            ?.emailAddress?.address,
          id: String(message.id),
          metadata: {
            internetMessageId: message.internetMessageId,
            provider: "graph",
          },
          receivedAt: message.receivedDateTime as string | undefined,
          sentAt: message.sentDateTime as string | undefined,
          subject: message.subject as string | undefined,
          threadId: message.conversationId as string | undefined,
          to: toGraphAddressList(
            message.toRecipients as Array<{
              emailAddress?: { address?: string };
            }>,
          ),
        } satisfies RAGEmailSyncMessage;
      }),
    );

    return {
      messages,
      nextCursor: listJson["@odata.nextLink"],
    };
  },
});

export const createRAGIMAPEmailSyncClient = (
  config: IMAPEmailSyncConfig,
): RAGEmailSyncClient => ({
  listMessages: async (
    input?: RAGEmailSyncListInput,
  ): Promise<RAGEmailSyncListResult> => {
    const mailbox = config.mailbox ?? "INBOX";
    const searchTerms = config.search?.length ? config.search : ["ALL"];
    const maxResults = input?.maxResults ?? config.maxResults ?? 100;
    const socket = connectTls({
      host: config.host,
      port: config.port ?? 993,
      rejectUnauthorized: true,
    });
    socket.setEncoding("utf8");

    let buffer = "";
    const readUntil = async (predicate: (chunk: string) => boolean) =>
      await new Promise<string>((resolve, reject) => {
        const onData = (chunk: string) => {
          buffer += chunk;
          if (predicate(buffer)) {
            socket.off("data", onData);
            resolve(buffer);
          }
        };
        const onError = (error: Error) => {
          socket.off("data", onData);
          reject(error);
        };
        socket.on("data", onData);
        socket.once("error", onError);
      });

    const send = async (tag: string, command: string) => {
      socket.write(`${tag} ${command}\r\n`);
      const response = await readUntil(
        (chunk) =>
          chunk.includes(`\r\n${tag} OK`) || chunk.startsWith(`${tag} OK`),
      );
      buffer = "";
      return response;
    };

    await readUntil((chunk) => chunk.includes("\r\n") || chunk.startsWith("*"));
    buffer = "";
    await send("A001", `LOGIN "${config.username}" "${config.password}"`);
    await send("A002", `SELECT "${mailbox}"`);
    const searchResponse = await send(
      "A003",
      `UID SEARCH ${searchTerms.join(" ")}`,
    );
    const uidLine = searchResponse
      .split(/\r?\n/)
      .find((line) => line.startsWith("* SEARCH"));
    const uids = (uidLine?.replace("* SEARCH", "").trim().split(/\s+/) ?? [])
      .filter(Boolean)
      .slice(-maxResults);

    const messages: RAGEmailSyncMessage[] = [];
    for (const uid of uids) {
      const response = await send(`F${uid}`, `UID FETCH ${uid} BODY.PEEK[]`);
      const rawMatch = response.match(
        /\{(\d+)\}\r\n([\s\S]*?)\r\nF[^\r\n]+ OK/,
      );
      const raw = rawMatch?.[2]?.trim();
      if (!raw) {
        continue;
      }

      const parsed = parseRawEmail(raw);
      messages.push({
        ...parsed,
        metadata: {
          ...(parsed.metadata ?? {}),
          imapMailbox: mailbox,
          imapUid: uid,
          provider: "imap",
        },
      });
    }

    socket.end("ZZZZ LOGOUT\r\n");
    return { messages };
  },
});
