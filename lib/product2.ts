/**
 * Salesforce Product2 write helpers for the IKI Product2-write MCP server.
 *
 * Field names are restricted to a conservative Salesforce API-name pattern
 * (leading letter, alphanumerics/underscores, optional `__c` custom-field
 * suffix) so a caller can never smuggle relationship traversal
 * (`Owner.Name`), the `attributes` envelope, or an `Id` override into the
 * write body. The actual create/update calls are unconditional here —
 * the confirm-before-write gate lives in the tool layer (route.ts), not here.
 */

import { sfFetch, SF_API_VERSION } from "@/lib/salesforce";

const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}(__c)?$/;
const DISALLOWED_FIELDS = new Set(["Id", "id", "attributes"]);

export type FieldValue = string | number | boolean | null;

export type FieldSanitization =
  | { ok: true; fields: Record<string, FieldValue> }
  | { ok: false; error: string };

/** Validate a proposed Product2 field map before it reaches Salesforce. */
export function sanitizeProduct2Fields(
  fields: Record<string, FieldValue>,
): FieldSanitization {
  const entries = Object.entries(fields ?? {});
  if (entries.length === 0) {
    return { ok: false, error: "Provide at least one field to write." };
  }

  const bad = entries
    .map(([key]) => key)
    .filter((key) => DISALLOWED_FIELDS.has(key) || !FIELD_NAME_PATTERN.test(key));

  if (bad.length > 0) {
    return {
      ok: false,
      error:
        `Invalid or disallowed field name(s): ${bad.join(", ")}. ` +
        'Field names must be plain Salesforce API names (e.g. "Name", "ProductCode", ' +
        '"My_Field__c") -- no "Id", "attributes", or relationship paths like "Owner.Name".',
    };
  }

  return { ok: true, fields: Object.fromEntries(entries) };
}

export interface Product2CreateResult {
  id: string;
  success: boolean;
  errors: unknown[];
}

/** Create a Product2 record. Caller must sanitize `fields` first. */
export async function createProduct2(
  fields: Record<string, FieldValue>,
): Promise<Product2CreateResult> {
  const result = await sfFetch(`/services/data/${SF_API_VERSION}/sobjects/Product2`, {
    method: "POST",
    body: JSON.stringify(fields),
  });
  return result as Product2CreateResult;
}

/**
 * Update a Product2 record by Id. Salesforce returns an empty 204 on
 * success, so this resolves to void; failures throw SalesforceError.
 * Caller must sanitize `fields` first.
 */
export async function updateProduct2(
  id: string,
  fields: Record<string, FieldValue>,
): Promise<void> {
  await sfFetch(
    `/services/data/${SF_API_VERSION}/sobjects/Product2/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(fields) },
  );
}
