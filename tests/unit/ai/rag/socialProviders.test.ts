import { describe, expect, it } from "bun:test";
import {
  createRAGFacebookPageConnector,
  createRAGInstagramBusinessConnector,
} from "../../../../src/ai/rag/socialProviders";

const createFetch = (
  handler: (url: string) => Response | Promise<Response>,
): typeof fetch =>
  Object.assign(
    (input: RequestInfo | URL) =>
      handler(String(input)) as ReturnType<typeof fetch>,
    { preconnect: fetch.preconnect },
  ) as typeof fetch;

describe("RAG social provider adapters", () => {
  it("maps Facebook Page posts into connector items", async () => {
    const runtime = createRAGFacebookPageConnector({
      fetch: createFetch(
        () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  created_time: "2026-04-20T12:00:00+0000",
                  from: { id: "page-1", name: "AbsoluteJS" },
                  full_picture: "https://cdn.example.com/post-1.jpg",
                  id: "page-1_post-1",
                  message:
                    "Facebook Page posts should flow through the connector runtime.",
                  permalink_url: "https://facebook.example/page-1/posts/post-1",
                  status_type: "added_photos",
                  updated_time: "2026-04-20T12:30:00+0000",
                },
              ],
              paging: { cursors: { after: "cursor-1" } },
            }),
            { status: 200 },
          ),
      ),
    });

    const result = await runtime.sync({
      credential: {
        authProviderKey: "facebook",
        bindingId: "facebook:user-1:page-1",
        connectorProvider: "facebook",
        externalAccountId: "page-1",
        externalAccountType: "page",
        grantId: "facebook:user-1",
        metadata: {
          pageAccessToken: "page-token",
          pageName: "AbsoluteJS",
        },
        ownerRef: "FACEBOOK|user-1",
        providerFamily: "meta",
        scopes: ["pages_show_list", "pages_read_engagement"],
      },
      resolver: {
        getAccessToken: async () => ({
          accessToken: "user-token",
          grantedScopes: ["pages_show_list", "pages_read_engagement"],
        }),
        listBindings: async () => [],
        reportFailure: async () => {},
        resolveCredential: async () => null,
      },
    });

    expect(result).toMatchObject({
      items: [
        {
          id: "page-1_post-1",
          kind: "facebook_post",
          metadata: {
            facebookPageId: "page-1",
            facebookPageName: "AbsoluteJS",
            provider: "facebook",
          },
          text: "Facebook Page posts should flow through the connector runtime.",
          title:
            "Facebook Page posts should flow through the connector runtime.",
          url: "https://facebook.example/page-1/posts/post-1",
        },
      ],
      nextCheckpoint: { after: "cursor-1" },
    });
  });

  it("maps Instagram business media into connector items", async () => {
    const runtime = createRAGInstagramBusinessConnector({
      fetch: createFetch(
        () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  caption: "Instagram business media should be searchable too.",
                  id: "ig-media-1",
                  media_type: "IMAGE",
                  media_url: "https://cdn.example.com/ig-media-1.jpg",
                  permalink: "https://instagram.example/p/ig-media-1",
                  thumbnail_url: "https://cdn.example.com/ig-thumb-1.jpg",
                  timestamp: "2026-04-21T10:15:00+0000",
                  username: "absolutejs",
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    });

    const result = await runtime.sync({
      credential: {
        authProviderKey: "facebook",
        bindingId: "instagram:user-1:ig-1",
        connectorProvider: "instagram",
        externalAccountId: "ig-1",
        externalAccountType: "instagram_business",
        grantId: "facebook:user-1",
        metadata: {
          instagramUsername: "absolutejs",
          parentPageAccessToken: "page-token",
        },
        ownerRef: "FACEBOOK|user-1",
        providerFamily: "meta",
        scopes: ["pages_show_list", "instagram_basic"],
      },
      resolver: {
        getAccessToken: async () => ({
          accessToken: "user-token",
          grantedScopes: ["pages_show_list", "instagram_basic"],
        }),
        listBindings: async () => [],
        reportFailure: async () => {},
        resolveCredential: async () => null,
      },
    });

    expect(result).toMatchObject({
      items: [
        {
          id: "ig-media-1",
          kind: "instagram_media",
          metadata: {
            instagramMediaType: "IMAGE",
            instagramUsername: "absolutejs",
            provider: "instagram",
          },
          text: "Instagram business media should be searchable too.",
          title: "Instagram business media should be searchable too.",
          url: "https://instagram.example/p/ig-media-1",
        },
      ],
    });
  });
});
