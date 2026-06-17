import type {
  RAGConnectorItem,
  RAGConnectorRuntime,
} from "../../types/engine";

const defaultFetch = Object.assign(
  (...args: Parameters<typeof fetch>) => fetch(...args),
  { preconnect: fetch.preconnect },
) as typeof fetch;

const GOOGLE_PEOPLE_BASE_URL = "https://people.googleapis.com/v1";
const DEFAULT_GOOGLE_CONTACTS_PAGE_SIZE = 200;

export const GOOGLE_CONTACTS_READ_SCOPES = [
  "https://www.googleapis.com/auth/contacts.readonly",
];

type GooglePeopleConnectionsResponse = {
  connections?: GooglePerson[];
  nextPageToken?: string;
  totalItems?: number;
  totalPeople?: number;
};

type GooglePerson = {
  resourceName?: string;
  etag?: string;
  names?: Array<{
    displayName?: string;
    givenName?: string;
    familyName?: string;
  }>;
  emailAddresses?: Array<{
    value?: string;
    formattedType?: string;
  }>;
  phoneNumbers?: Array<{
    value?: string;
    canonicalForm?: string;
    formattedType?: string;
  }>;
  organizations?: Array<{
    name?: string;
    title?: string;
  }>;
  biographies?: Array<{
    value?: string;
  }>;
  urls?: Array<{
    value?: string;
    formattedType?: string;
  }>;
  photos?: Array<{
    url?: string;
    default?: boolean;
  }>;
};

type GoogleErrorBody = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

const toErrorMessage = async (response: Response, label: string) => {
  let detailMessage: string | undefined;

  try {
    const body = (await response.clone().json()) as GoogleErrorBody;
    detailMessage = body.error?.message;
  } catch {
    const text = await response.clone().text();
    detailMessage = text.trim().length > 0 ? text.trim() : undefined;
  }

  return new Error(
    `${label}: ${response.status} ${response.statusText}${detailMessage ? ` (${detailMessage})` : ""}`,
  );
};

const normalizeString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const toUniqueStringArray = (values: Array<string | undefined>) => [
  ...new Set(
    values.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  ),
];

const toContactTitle = (person: GooglePerson, fallbackId: string) => {
  const primaryName = person.names?.find(
    (name) => normalizeString(name.displayName) !== undefined,
  );
  const displayName = normalizeString(primaryName?.displayName);
  if (displayName) {
    return displayName;
  }

  const primaryEmail = normalizeString(person.emailAddresses?.[0]?.value);
  if (primaryEmail) {
    return primaryEmail;
  }

  return `Google contact ${fallbackId}`;
};

const toContactText = (person: GooglePerson) => {
  const name = normalizeString(person.names?.[0]?.displayName);
  const givenName = normalizeString(person.names?.[0]?.givenName);
  const familyName = normalizeString(person.names?.[0]?.familyName);
  const emails = toUniqueStringArray(
    (person.emailAddresses ?? []).map((entry) => normalizeString(entry.value)),
  );
  const phones = toUniqueStringArray(
    (person.phoneNumbers ?? []).map(
      (entry) =>
        normalizeString(entry.value) ?? normalizeString(entry.canonicalForm),
    ),
  );
  const organizations = toUniqueStringArray(
    (person.organizations ?? []).flatMap((entry) => [
      normalizeString(entry.name),
      normalizeString(entry.title),
    ]),
  );
  const biography = normalizeString(person.biographies?.[0]?.value);
  const urls = toUniqueStringArray(
    (person.urls ?? []).map((entry) => normalizeString(entry.value)),
  );

  return [
    name,
    givenName && familyName
      ? `${givenName} ${familyName}`
      : (givenName ?? familyName),
    emails.length > 0 ? `Emails: ${emails.join(", ")}` : undefined,
    phones.length > 0 ? `Phones: ${phones.join(", ")}` : undefined,
    organizations.length > 0
      ? `Organizations: ${organizations.join(", ")}`
      : undefined,
    biography,
    urls.length > 0 ? `Links: ${urls.join(", ")}` : undefined,
  ]
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .join("\n");
};

const toContactItem = (person: GooglePerson): RAGConnectorItem | null => {
  const resourceName = normalizeString(person.resourceName);
  if (!resourceName) {
    return null;
  }

  const contactId = resourceName.replace(/^people\//, "");
  const title = toContactTitle(person, contactId);
  const emails = toUniqueStringArray(
    (person.emailAddresses ?? []).map((entry) => normalizeString(entry.value)),
  );
  const phones = toUniqueStringArray(
    (person.phoneNumbers ?? []).map(
      (entry) =>
        normalizeString(entry.value) ?? normalizeString(entry.canonicalForm),
    ),
  );
  const organizations = (person.organizations ?? [])
    .map((entry) => ({
      name: normalizeString(entry.name),
      title: normalizeString(entry.title),
    }))
    .filter((entry) => entry.name || entry.title);
  const urls = toUniqueStringArray(
    (person.urls ?? []).map((entry) => normalizeString(entry.value)),
  );
  const photoUrl = normalizeString(
    person.photos?.find((photo) => normalizeString(photo.url) !== undefined)
      ?.url,
  );
  const text = toContactText(person);

  return {
    id: resourceName,
    kind: "google_contact",
    metadata: {
      emails,
      etag: normalizeString(person.etag),
      organizations,
      phones,
      photoUrl,
      provider: "google_contacts",
      resourceName,
      urls,
    },
    text: text.length > 0 ? text : title,
    title,
    url: urls[0],
  };
};

export const createRAGGoogleContactsConnector = (input?: {
  baseUrl?: string;
  fetch?: typeof fetch;
  pageSize?: number;
}): RAGConnectorRuntime => ({
  provider: "google_contacts",
  requiredScopes: () => GOOGLE_CONTACTS_READ_SCOPES,
  sync: async ({ checkpoint, credential, resolver }) => {
    const lease = await resolver.getAccessToken(credential, {
      requiredScopes: GOOGLE_CONTACTS_READ_SCOPES,
    });

    const fetchImpl = input?.fetch ?? defaultFetch;
    const url = new URL(
      `${input?.baseUrl ?? GOOGLE_PEOPLE_BASE_URL}/people/me/connections`,
    );
    url.searchParams.set(
      "personFields",
      [
        "names",
        "emailAddresses",
        "phoneNumbers",
        "organizations",
        "biographies",
        "urls",
        "photos",
      ].join(","),
    );
    url.searchParams.set(
      "pageSize",
      String(input?.pageSize ?? DEFAULT_GOOGLE_CONTACTS_PAGE_SIZE),
    );

    const pageToken = normalizeString(checkpoint?.pageToken);
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${lease.accessToken}`,
      },
    });
    if (!response.ok) {
      throw await toErrorMessage(
        response,
        `Google Contacts sync failed for ${credential.externalAccountId}`,
      );
    }

    const json = (await response.json()) as GooglePeopleConnectionsResponse;
    return {
      items: (json.connections ?? [])
        .map((person) => toContactItem(person))
        .filter(Boolean) as RAGConnectorItem[],
      nextCheckpoint: normalizeString(json.nextPageToken)
        ? { pageToken: normalizeString(json.nextPageToken) }
        : undefined,
      diagnostics: {
        listedCount: json.connections?.length ?? 0,
        nextPageToken: normalizeString(json.nextPageToken),
        totalItems: json.totalItems,
        totalPeople: json.totalPeople,
      },
    };
  },
});
