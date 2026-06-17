import type {
  RAGConnectorItem,
  RAGConnectorRuntime,
} from "../../types/engine";

const defaultFetch = Object.assign(
  (...args: Parameters<typeof fetch>) => fetch(...args),
  { preconnect: fetch.preconnect },
) as typeof fetch;

const META_GRAPH_BASE_URL = "https://graph.facebook.com/v22.0";
const DEFAULT_META_PAGE_SIZE = 25;

export const FACEBOOK_PAGE_READ_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
];

export const INSTAGRAM_BUSINESS_READ_SCOPES = [
  "pages_show_list",
  "instagram_basic",
];

type GraphPaging = {
  cursors?: {
    after?: string;
    before?: string;
  };
  next?: string;
};

type GraphListResponse<T> = {
  data?: T[];
  paging?: GraphPaging;
};

type GraphErrorBody = {
  error?: {
    code?: number;
    message?: string;
    type?: string;
    error_subcode?: number;
  };
};

type FacebookPost = {
  id?: string;
  message?: string;
  created_time?: string;
  updated_time?: string;
  permalink_url?: string;
  full_picture?: string;
  status_type?: string;
  from?: {
    id?: string;
    name?: string;
  };
};

type InstagramMedia = {
  id?: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  permalink?: string;
  thumbnail_url?: string;
  timestamp?: string;
  username?: string;
};

const toErrorMessage = async (response: Response, label: string) => {
  let detailMessage: string | undefined;

  try {
    const body = (await response.clone().json()) as GraphErrorBody;
    detailMessage = body.error?.message;
  } catch {
    const text = await response.clone().text();
    detailMessage = text.trim().length > 0 ? text.trim() : undefined;
  }

  return new Error(
    `${label}: ${response.status} ${response.statusText}${detailMessage ? ` (${detailMessage})` : ""}`,
  );
};

const fetchGraphList = async <T>(input: {
  accessToken: string;
  after?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  fields: string[];
  label: string;
  limit?: number;
  path: string;
}) => {
  const fetchImpl = input.fetch ?? defaultFetch;
  const url = new URL(`${input.baseUrl ?? META_GRAPH_BASE_URL}${input.path}`);
  url.searchParams.set("access_token", input.accessToken);
  url.searchParams.set("fields", input.fields.join(","));
  url.searchParams.set("limit", String(input.limit ?? DEFAULT_META_PAGE_SIZE));
  if (typeof input.after === "string" && input.after.length > 0) {
    url.searchParams.set("after", input.after);
  }

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw await toErrorMessage(response, input.label);
  }

  return (await response.json()) as GraphListResponse<T>;
};

const getCheckpointAfter = (
  checkpoint: Record<string, unknown> | undefined,
) => {
  const after = checkpoint?.after;
  return typeof after === "string" && after.trim().length > 0
    ? after.trim()
    : undefined;
};

const getCredentialMetadataString = (
  metadata: Record<string, unknown> | undefined,
  key: string,
) => {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
};

const toFacebookPostItem = (
  credential: { externalAccountId: string; metadata?: Record<string, unknown> },
  post: FacebookPost,
): RAGConnectorItem | null => {
  if (typeof post.id !== "string" || post.id.trim().length === 0) {
    return null;
  }

  const pageName =
    getCredentialMetadataString(credential.metadata, "label") ??
    getCredentialMetadataString(credential.metadata, "pageName") ??
    getCredentialMetadataString(credential.metadata, "parentPageName");
  const message = post.message?.trim() ?? "";

  return {
    createdAt: post.created_time,
    html: undefined,
    id: post.id,
    kind: "facebook_post",
    metadata: {
      facebookPageId: credential.externalAccountId,
      facebookPageName: pageName,
      facebookPictureUrl: post.full_picture,
      facebookStatusType: post.status_type,
      provider: "facebook",
      providerAuthorId: post.from?.id,
      providerAuthorName: post.from?.name,
    },
    text: message.length > 0 ? message : post.permalink_url,
    title:
      message.length > 0 ? message.slice(0, 120) : `Facebook post ${post.id}`,
    updatedAt: post.updated_time,
    url: post.permalink_url,
  };
};

const toInstagramMediaItem = (
  credential: { externalAccountId: string; metadata?: Record<string, unknown> },
  media: InstagramMedia,
): RAGConnectorItem | null => {
  if (typeof media.id !== "string" || media.id.trim().length === 0) {
    return null;
  }

  const caption = media.caption?.trim() ?? "";
  const username = getCredentialMetadataString(
    credential.metadata,
    "instagramUsername",
  );

  return {
    createdAt: media.timestamp,
    id: media.id,
    kind: "instagram_media",
    metadata: {
      instagramMediaType: media.media_type,
      instagramThumbnailUrl: media.thumbnail_url,
      instagramUsername: media.username ?? username,
      provider: "instagram",
      providerAccountId: credential.externalAccountId,
      providerMediaUrl: media.media_url,
    },
    text: caption.length > 0 ? caption : media.permalink,
    title:
      caption.length > 0
        ? caption.slice(0, 120)
        : `Instagram media ${media.id}`,
    url: media.permalink,
  };
};

export const createRAGFacebookPageConnector = (input?: {
  baseUrl?: string;
  fetch?: typeof fetch;
  limit?: number;
}): RAGConnectorRuntime => ({
  provider: "facebook",
  requiredScopes: () => FACEBOOK_PAGE_READ_SCOPES,
  sync: async ({ checkpoint, credential, resolver }) => {
    const lease = await resolver.getAccessToken(credential, {
      requiredScopes: FACEBOOK_PAGE_READ_SCOPES,
    });
    const pageAccessToken =
      getCredentialMetadataString(credential.metadata, "pageAccessToken") ??
      lease.accessToken;
    const response = await fetchGraphList<FacebookPost>({
      accessToken: pageAccessToken,
      after: getCheckpointAfter(checkpoint),
      baseUrl: input?.baseUrl,
      fetch: input?.fetch,
      fields: [
        "id",
        "message",
        "created_time",
        "updated_time",
        "permalink_url",
        "full_picture",
        "status_type",
        "from{id,name}",
      ],
      label: `Facebook Page sync failed for ${credential.externalAccountId}`,
      limit: input?.limit,
      path: `/${encodeURIComponent(credential.externalAccountId)}/posts`,
    });

    return {
      items: (response.data ?? [])
        .map((post) => toFacebookPostItem(credential, post))
        .filter(Boolean) as RAGConnectorItem[],
      nextCheckpoint: response.paging?.cursors?.after
        ? { after: response.paging.cursors.after }
        : undefined,
      diagnostics: {
        listedCount: response.data?.length ?? 0,
        nextAfter: response.paging?.cursors?.after,
      },
    };
  },
});

export const createRAGInstagramBusinessConnector = (input?: {
  baseUrl?: string;
  fetch?: typeof fetch;
  limit?: number;
}): RAGConnectorRuntime => ({
  provider: "instagram",
  requiredScopes: () => INSTAGRAM_BUSINESS_READ_SCOPES,
  sync: async ({ checkpoint, credential, resolver }) => {
    const lease = await resolver.getAccessToken(credential, {
      requiredScopes: INSTAGRAM_BUSINESS_READ_SCOPES,
    });
    const accessToken =
      getCredentialMetadataString(
        credential.metadata,
        "parentPageAccessToken",
      ) ?? lease.accessToken;
    const response = await fetchGraphList<InstagramMedia>({
      accessToken,
      after: getCheckpointAfter(checkpoint),
      baseUrl: input?.baseUrl,
      fetch: input?.fetch,
      fields: [
        "id",
        "caption",
        "media_type",
        "media_url",
        "permalink",
        "thumbnail_url",
        "timestamp",
        "username",
      ],
      label: `Instagram business sync failed for ${credential.externalAccountId}`,
      limit: input?.limit,
      path: `/${encodeURIComponent(credential.externalAccountId)}/media`,
    });

    return {
      items: (response.data ?? [])
        .map((media) => toInstagramMediaItem(credential, media))
        .filter(Boolean) as RAGConnectorItem[],
      nextCheckpoint: response.paging?.cursors?.after
        ? { after: response.paging.cursors.after }
        : undefined,
      diagnostics: {
        listedCount: response.data?.length ?? 0,
        nextAfter: response.paging?.cursors?.after,
      },
    };
  },
});
