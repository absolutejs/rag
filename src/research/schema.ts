import {
  Kind,
  type TSchema,
  type Static as LegacyStatic,
} from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Static } from "typebox";
import { Check, Errors } from "typebox/value";

/** JSON-compatible TypeBox 0.34 or TypeBox 1 schemas, including Elysia 2's t. */
export type ResearchSchema = TSchema | { "~kind": string };
export type ResearchStatic<S extends ResearchSchema> = S extends TSchema
  ? LegacyStatic<S>
  : Static<S>;

const isLegacySchema = (schema: ResearchSchema): schema is TSchema =>
  Kind in schema;

export const checkResearchValue = <S extends ResearchSchema>(
  schema: S,
  value: unknown,
): value is ResearchStatic<S> => {
  // The two TypeBox generations use different schema markers and validators.
  // Never cast a modern schema into the legacy validator's contract.
  if (isLegacySchema(schema)) return Value.Check(schema, value);
  return Check(schema, value);
};

/** Schema locations/messages only; never include the invalid document value. */
export const researchValidationDiagnostics = (
  schema: ResearchSchema,
  value: unknown,
) => {
  const errors = isLegacySchema(schema)
    ? [...Value.Errors(schema, value)].map(
        (error) => `${error.path || "/"}: ${error.message}`,
      )
    : Errors(schema, value).map(
        (error) => `${error.instancePath || "/"}: ${error.message}`,
      );
  return errors.slice(0, 8).join("; ").slice(0, 2000);
};
