import { describe, expect, it } from "bun:test";
import { createRAGGoogleContactsConnector } from "../../../../src/ai/rag/contactProviders";

const createFetch = (
  handler: (url: string) => Response | Promise<Response>,
): typeof fetch =>
  Object.assign(
    (input: RequestInfo | URL) =>
      handler(String(input)) as ReturnType<typeof fetch>,
    { preconnect: fetch.preconnect },
  ) as typeof fetch;

describe("RAG contact provider adapters", () => {
  it("maps Google contacts into connector items", async () => {
    const runtime = createRAGGoogleContactsConnector({
      fetch: createFetch(() =>
        new Response(
          JSON.stringify({
            connections: [
              {
                biographies: [{ value: "AbsoluteJS client contact" }],
                emailAddresses: [{ value: "alex@example.com" }],
                etag: "%EgQBAgMEBQYHCAkKCwwNDg8QERITFA==",
                names: [
                  {
                    displayName: "Alex Kahn",
                    familyName: "Kahn",
                    givenName: "Alex",
                  },
                ],
                organizations: [
                  { name: "AbsoluteJS", title: "Founder" },
                ],
                phoneNumbers: [{ value: "+1 555-0100" }],
                photos: [{ url: "https://cdn.example.com/alex.jpg" }],
                resourceName: "people/c123",
                urls: [{ value: "https://absolutejs.com" }],
              },
            ],
            nextPageToken: "contacts-page-2",
            totalPeople: 1,
          }),
          { status: 200 },
        ),
      ),
    });

    const result = await runtime.sync({
      credential: {
        authProviderKey: "google",
        bindingId: "google_contacts:sub:alex@example.com",
        connectorProvider: "google_contacts",
        externalAccountId: "alex@example.com",
        externalAccountType: "contacts",
        grantId: "google:sub",
        ownerRef: "sub",
        providerFamily: "google",
        scopes: ["https://www.googleapis.com/auth/contacts.readonly"],
      },
      resolver: {
        getAccessToken: async () => ({
          accessToken: "contacts-token",
          grantedScopes: ["https://www.googleapis.com/auth/contacts.readonly"],
        }),
        listBindings: async () => [],
        reportFailure: async () => {},
        resolveCredential: async () => null,
      },
    });

    expect(result).toMatchObject({
      items: [
        {
          id: "people/c123",
          kind: "google_contact",
          metadata: {
            emails: ["alex@example.com"],
            phones: ["+1 555-0100"],
            provider: "google_contacts",
            resourceName: "people/c123",
          },
          text: expect.stringContaining("alex@example.com"),
          title: "Alex Kahn",
          url: "https://absolutejs.com",
        },
      ],
      nextCheckpoint: { pageToken: "contacts-page-2" },
    });
  });
});
