import { describe, expect, it } from "bun:test";
import {
  createRAGGmailEmailSyncClient,
  createRAGGraphEmailSyncClient,
  createRAGLinkedGmailEmailSyncClient,
} from "../src/providers/emailProviders";

const createFetch = (
  handler: (url: string) => Response | Promise<Response>,
): typeof fetch =>
  Object.assign(
    (input: RequestInfo | URL) =>
      handler(String(input)) as ReturnType<typeof fetch>,
    { preconnect: fetch.preconnect },
  ) as typeof fetch;

describe("RAG email provider adapters", () => {
  it("maps Gmail messages and attachments into email sync messages", async () => {
    const client = createRAGGmailEmailSyncClient({
      accessToken: "token",
      fetch: createFetch((url) => {
        if (url.includes("/messages?")) {
          return new Response(
            JSON.stringify({
              messages: [{ id: "msg-1", threadId: "thread-1" }],
            }),
            { status: 200 },
          );
        }

        if (url.includes("/attachments/att-1")) {
          return new Response(
            JSON.stringify({
              data: Buffer.from("# Refund Attachment", "utf8")
                .toString("base64")
                .replace(/\+/g, "-")
                .replace(/\//g, "_")
                .replace(/=+$/g, ""),
            }),
            { status: 200 },
          );
        }

        return new Response(
          JSON.stringify({
            id: "msg-1",
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "Subject", value: "Refund workflow" },
                { name: "From", value: "ops@example.com" },
                { name: "To", value: "support@example.com" },
              ],
              mimeType: "multipart/mixed",
              parts: [
                {
                  body: {
                    data: Buffer.from(
                      "Refund approvals should preserve sender identity.",
                      "utf8",
                    )
                      .toString("base64")
                      .replace(/\+/g, "-")
                      .replace(/\//g, "_")
                      .replace(/=+$/g, ""),
                  },
                  mimeType: "text/plain",
                },
                {
                  body: { attachmentId: "att-1" },
                  filename: "refund.md",
                  mimeType: "text/markdown",
                },
              ],
            },
            threadId: "thread-1",
          }),
          { status: 200 },
        );
      }),
    });

    const result = await client.listMessages();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      attachments: [{ name: "refund.md" }],
      bodyText: "Refund approvals should preserve sender identity.",
      from: "ops@example.com",
      subject: "Refund workflow",
      threadId: "thread-1",
      to: ["support@example.com"],
    });
  });

  it("retries Gmail 429 responses before succeeding", async () => {
    let listCalls = 0;
    let getCalls = 0;

    const client = createRAGGmailEmailSyncClient({
      accessToken: "token",
      fetch: createFetch((url) => {
        if (url.includes("/messages?")) {
          listCalls += 1;
          return new Response(
            JSON.stringify({
              messages: [{ id: "msg-1", threadId: "thread-1" }],
            }),
            {
              headers: { "retry-after": "0" },
              status: listCalls === 1 ? 429 : 200,
              statusText: listCalls === 1 ? "Too Many Requests" : "OK",
            },
          );
        }

        getCalls += 1;
        return new Response(
          JSON.stringify({
            id: "msg-1",
            payload: {
              headers: [{ name: "Subject", value: "Retried Gmail workflow" }],
              mimeType: "multipart/alternative",
              parts: [
                {
                  body: {
                    data: Buffer.from("Retried Gmail fetch succeeded.", "utf8")
                      .toString("base64")
                      .replace(/\+/g, "-")
                      .replace(/\//g, "_")
                      .replace(/=+$/g, ""),
                  },
                  mimeType: "text/plain",
                },
              ],
            },
            threadId: "thread-1",
          }),
          { status: 200 },
        );
      }),
    });

    const result = await client.listMessages();
    expect(result.messages[0]).toMatchObject({
      bodyText: "Retried Gmail fetch succeeded.",
      subject: "Retried Gmail workflow",
    });
    expect(listCalls).toBe(2);
    expect(getCalls).toBe(1);
  });

  it("resolves linked Gmail credentials through the shared resolver contract", async () => {
    const resolveInputs: Array<Record<string, unknown>> = [];
    const accessInputs: Array<Record<string, unknown>> = [];
    const credential = {
      authProviderKey: "google",
      bindingId: "gmail:sub:support@example.com",
      connectorProvider: "gmail",
      externalAccountId: "support@example.com",
      externalAccountType: "mailbox",
      grantId: "google:sub",
      ownerRef: "GOOGLE|sub",
      providerFamily: "google",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    };

    const client = createRAGLinkedGmailEmailSyncClient({
      bindingId: credential.bindingId,
      fetch: createFetch((url) => {
        if (url.includes("/messages?")) {
          return new Response(
            JSON.stringify({
              messages: [{ id: "msg-1", threadId: "thread-1" }],
            }),
            { status: 200 },
          );
        }

        return new Response(
          JSON.stringify({
            id: "msg-1",
            payload: {
              headers: [
                { name: "Subject", value: "Linked Gmail workflow" },
                { name: "From", value: "ops@example.com" },
                { name: "To", value: "support@example.com" },
              ],
              mimeType: "multipart/alternative",
              parts: [
                {
                  body: {
                    data: Buffer.from(
                      "Linked Gmail sync should resolve durable credentials.",
                      "utf8",
                    )
                      .toString("base64")
                      .replace(/\+/g, "-")
                      .replace(/\//g, "_")
                      .replace(/=+$/g, ""),
                  },
                  mimeType: "text/plain",
                },
              ],
            },
            threadId: "thread-1",
          }),
          { status: 200 },
        );
      }),
      ownerRef: credential.ownerRef,
      resolver: {
        getAccessToken: async (resolvedCredential, input) => {
          accessInputs.push({ input, resolvedCredential });
          return {
            accessToken: "linked-token",
            grantedScopes: credential.scopes,
          };
        },
        listBindings: async () => [],
        reportFailure: async () => {},
        resolveCredential: async (input) => {
          resolveInputs.push(input as Record<string, unknown>);
          return credential;
        },
      },
    });

    const result = await client.listMessages();

    expect(result.messages[0]).toMatchObject({
      bodyText: "Linked Gmail sync should resolve durable credentials.",
      subject: "Linked Gmail workflow",
    });
    expect(resolveInputs).toHaveLength(1);
    expect(resolveInputs[0]).toMatchObject({
      bindingId: credential.bindingId,
      connectorProvider: "gmail",
      ownerRef: credential.ownerRef,
      purpose: "background_sync",
      requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    expect(accessInputs).toHaveLength(1);
    expect(accessInputs[0]).toMatchObject({
      input: {
        requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      },
      resolvedCredential: credential,
    });
  });

  it("reports linked Gmail credential failures back through the resolver", async () => {
    const failureReports: Array<Record<string, unknown>> = [];
    const credential = {
      authProviderKey: "google",
      bindingId: "gmail:sub:support@example.com",
      connectorProvider: "gmail",
      externalAccountId: "support@example.com",
      externalAccountType: "mailbox",
      grantId: "google:sub",
      ownerRef: "GOOGLE|sub",
      providerFamily: "google",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    };

    const client = createRAGLinkedGmailEmailSyncClient({
      ownerRef: credential.ownerRef,
      resolver: {
        getAccessToken: async () => {
          throw new Error("401 expired linked Gmail token");
        },
        listBindings: async () => [],
        reportFailure: async (resolvedCredential, report) => {
          failureReports.push({ report, resolvedCredential });
        },
        resolveCredential: async () => credential,
      },
    });

    await expect(client.listMessages()).rejects.toThrow(
      "401 expired linked Gmail token",
    );
    expect(failureReports).toEqual([
      {
        report: {
          code: "unauthorized",
          message: "401 expired linked Gmail token",
        },
        resolvedCredential: credential,
      },
    ]);
  });

  it("reports linked Gmail provider configuration failures without poisoning scope state", async () => {
    const failureReports: Array<Record<string, unknown>> = [];
    const credential = {
      authProviderKey: "google",
      bindingId: "gmail:sub:support@example.com",
      connectorProvider: "gmail",
      externalAccountId: "support@example.com",
      externalAccountType: "mailbox",
      grantId: "google:sub",
      ownerRef: "GOOGLE|sub",
      providerFamily: "google",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    };

    const client = createRAGLinkedGmailEmailSyncClient({
      fetch: createFetch((url) => {
        if (url.includes("/messages?")) {
          return new Response(
            JSON.stringify({
              error: {
                code: 403,
                errors: [
                  {
                    message:
                      "Gmail API has not been used in project 123 before or it is disabled.",
                    reason: "accessNotConfigured",
                  },
                ],
                message:
                  "Gmail API has not been used in project 123 before or it is disabled.",
                status: "PERMISSION_DENIED",
              },
            }),
            { status: 403, statusText: "Forbidden" },
          );
        }

        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }),
      ownerRef: credential.ownerRef,
      resolver: {
        getAccessToken: async () => ({
          accessToken: "linked-token",
          grantedScopes: credential.scopes,
        }),
        listBindings: async () => [],
        reportFailure: async (resolvedCredential, report) => {
          failureReports.push({ report, resolvedCredential });
        },
        resolveCredential: async () => credential,
      },
    });

    await expect(client.listMessages()).rejects.toThrow("accessNotConfigured");
    expect(failureReports).toEqual([
      {
        report: {
          code: "provider_error",
          message:
            "Gmail list failed: 403 Forbidden (accessNotConfigured | Gmail API has not been used in project 123 before or it is disabled.)",
        },
        resolvedCredential: credential,
      },
    ]);
  });

  it("reports linked Gmail rate limits distinctly", async () => {
    const failureReports: Array<Record<string, unknown>> = [];
    const credential = {
      authProviderKey: "google",
      bindingId: "gmail:sub:support@example.com",
      connectorProvider: "gmail",
      externalAccountId: "support@example.com",
      externalAccountType: "mailbox",
      grantId: "google:sub",
      ownerRef: "GOOGLE|sub",
      providerFamily: "google",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    };

    let listCalls = 0;
    const client = createRAGLinkedGmailEmailSyncClient({
      fetch: createFetch((url) => {
        if (url.includes("/messages?")) {
          listCalls += 1;
          return new Response(
            JSON.stringify({
              error: {
                code: 429,
                errors: [
                  {
                    message: "Quota exceeded for quota metric.",
                    reason: "rateLimitExceeded",
                  },
                ],
                message: "Quota exceeded for quota metric.",
                status: "RESOURCE_EXHAUSTED",
              },
            }),
            {
              headers: { "retry-after": "0" },
              status: 429,
              statusText: "Too Many Requests",
            },
          );
        }

        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }),
      ownerRef: credential.ownerRef,
      resolver: {
        getAccessToken: async () => ({
          accessToken: "linked-token",
          grantedScopes: credential.scopes,
        }),
        listBindings: async () => [],
        reportFailure: async (resolvedCredential, report) => {
          failureReports.push({ report, resolvedCredential });
        },
        resolveCredential: async () => credential,
      },
    });

    await expect(client.listMessages()).rejects.toThrow(
      "429 Too Many Requests",
    );
    expect(listCalls).toBe(3);
    expect(failureReports).toEqual([
      {
        report: {
          code: "rate_limited",
          message:
            "Gmail list failed: 429 Too Many Requests (rateLimitExceeded | Quota exceeded for quota metric.)",
        },
        resolvedCredential: credential,
      },
    ]);
  });

  it("maps Graph messages and file attachments into email sync messages", async () => {
    const client = createRAGGraphEmailSyncClient({
      accessToken: "token",
      fetch: createFetch((url) => {
        if (url.endsWith("/attachments")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  contentBytes: Buffer.from(
                    "# Policy Attachment",
                    "utf8",
                  ).toString("base64"),
                  contentType: "text/markdown",
                  id: "att-1",
                  name: "policy.md",
                },
              ],
            }),
            { status: 200 },
          );
        }

        return new Response(
          JSON.stringify({
            value: [
              {
                body: { content: "Graph email body text" },
                ccRecipients: [],
                conversationId: "thread-graph",
                from: {
                  emailAddress: { address: "ops@example.com" },
                },
                hasAttachments: true,
                id: "msg-1",
                internetMessageId: "<msg-1@example.com>",
                receivedDateTime: "2026-04-09T00:00:00Z",
                sentDateTime: "2026-04-09T00:00:00Z",
                subject: "Graph workflow",
                toRecipients: [
                  {
                    emailAddress: {
                      address: "support@example.com",
                    },
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }),
    });

    const result = await client.listMessages();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      attachments: [{ name: "policy.md" }],
      bodyText: "Graph email body text",
      from: "ops@example.com",
      subject: "Graph workflow",
      threadId: "thread-graph",
      to: ["support@example.com"],
    });
  });

  it("includes Microsoft Graph error details on message list failures", async () => {
    const client = createRAGGraphEmailSyncClient({
      accessToken: "token",
      fetch: createFetch(() =>
        new Response(
          JSON.stringify({
            error: {
              code: "ErrorAccessDenied",
              message: "Access is denied. Check mailbox permissions.",
            },
          }),
          { status: 403, statusText: "Forbidden" },
        ),
      ),
    });

    await expect(client.listMessages()).rejects.toThrow(
      /ErrorAccessDenied.*Check mailbox permissions/,
    );
  });
});
