import {
  Kind,
  type TSchema,
  type Static as LegacyStatic,
} from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Static } from "typebox";
import { Check } from "typebox/value";

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
