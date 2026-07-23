// uploadAdmission.ts — the request-side half of the upload-security envelope (import-redesign 13 §1, step
// S-S1), shared by the sync route (routes.ts) and the dark bulk route (bulkRoutes.ts). Three controls live
// here, all BEFORE any parse or store: (1) the whole-body byte gate — reject on Content-Length when
// declared, AND count bytes on the multipart stream aborting at ceiling+1, so a lying Content-Length never
// buffers past the cap (13 §1.2); (2) multipart hardening — part count, per-field size, exactly one `file`
// part, extras REJECTED not ignored (13 §1.5); (3) per-format content admission — magic-byte sniffing and
// encoding rules from @leadwolf/core's admission module (13 §1.1/§1.3). Caps are core's single admission
// constants spot (S-P2 will centralize). Errors are RFC-9457 (415 unsupported_media_type, 413
// file_too_large/xlsx_too_large per 08 §2.3) rendered by the global onError.

import {
  IMPORT_CSV_MAX_BYTES,
  IMPORT_CSV_SNIFF_PREFIX_BYTES,
  IMPORT_MULTIPART_MAX_FIELD_BYTES,
  IMPORT_MULTIPART_MAX_PARTS,
  IMPORT_UPLOAD_REQUEST_MAX_BYTES,
  IMPORT_XLSX_MAX_BYTES,
  assertCsvPrefixAdmissible,
  assertXlsxAdmissible,
  decodeAdmittedCsv,
  isXlsxFile,
} from "@leadwolf/core";
import {
  FileTooLargeError,
  ImportValidationError,
  UnsupportedMediaTypeError,
} from "@leadwolf/types";

/** Marker for the mid-stream abort so the formData() rejection maps back to the typed 413. */
const OVER_CEILING = Symbol("upload_over_ceiling");
interface OverCeiling {
  [OVER_CEILING]: true;
}
function overCeilingError(): Error & OverCeiling {
  return Object.assign(new Error("upload over ceiling"), { [OVER_CEILING]: true as const });
}
function isOverCeiling(err: unknown): err is OverCeiling {
  return typeof err === "object" && err !== null && OVER_CEILING in err;
}

/**
 * Parse the import multipart body under the byte + multipart hardening caps. The request body stream is
 * wrapped in a counting TransformStream that ERRORS past `maxBytes` — the multipart parser is fed the
 * wrapped stream, so an over-ceiling body aborts mid-read instead of buffering to completion. After a
 * successful parse the multipart SHAPE is enforced: ≤ MAX_PARTS entries, exactly one File part and only
 * under the name `file` (a second file part anywhere is rejected, not ignored), and every text field
 * ≤ MAX_FIELD_BYTES. Field names/values are never echoed into errors.
 */
export async function admittedImportFormData(
  req: Request,
  maxBytes: number = IMPORT_UPLOAD_REQUEST_MAX_BYTES,
): Promise<FormData> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new FileTooLargeError("file_too_large", IMPORT_CSV_MAX_BYTES);
  }

  let form: FormData;
  if (!req.body) {
    form = await req.formData().catch(() => {
      throw new ImportValidationError("The request is not a readable multipart form.");
    });
  } else {
    let seen = 0;
    const counted = req.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > maxBytes) controller.error(overCeilingError());
          else controller.enqueue(chunk);
        },
      }),
    );
    // Re-wrap with the SAME headers (the multipart boundary lives there) over the counted stream.
    const wrapped = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: counted,
      // Streaming request bodies require half-duplex; not yet in the RequestInit type.
      duplex: "half",
    } as RequestInit);
    try {
      form = await wrapped.formData();
    } catch (err) {
      if (isOverCeiling(err)) throw new FileTooLargeError("file_too_large", IMPORT_CSV_MAX_BYTES);
      throw new ImportValidationError("The request is not a readable multipart form.");
    }
  }

  let parts = 0;
  let sawFile = false;
  for (const [name, value] of form.entries()) {
    parts++;
    if (parts > IMPORT_MULTIPART_MAX_PARTS) {
      throw new ImportValidationError("The upload form has too many parts.");
    }
    if (typeof value !== "string") {
      if (name !== "file" || sawFile) {
        throw new ImportValidationError("Exactly one file part (field 'file') is allowed.");
      }
      sawFile = true;
    } else if (typeof value === "string" && value.length > IMPORT_MULTIPART_MAX_FIELD_BYTES) {
      throw new ImportValidationError("A form field exceeds the allowed size.");
    }
  }
  return form;
}

/**
 * Read + admit the sync route's upload content (13 §1.1–§1.3): per-format byte cap (413 with 08 §2.3's
 * format-specific slug), then content admission — XLSX by ZIP magic + workbook-part presence (415 on
 * mismatch, at ADMISSION time rather than as a corrupt-parse 422), CSV by binary-magic/NUL sniff + BOM-
 * aware decode (UTF-8 default, UTF-16 per BOM; systemic mojibake ⇒ 422). Returns the shape
 * `parseImportFile` expects: bytes for .xlsx, decoded text for CSV.
 */
export async function readAdmittedImportContent(file: File): Promise<string | Uint8Array> {
  if (isXlsxFile(file.name)) {
    if (file.size > IMPORT_XLSX_MAX_BYTES) {
      throw new FileTooLargeError("xlsx_too_large", IMPORT_XLSX_MAX_BYTES);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    assertXlsxAdmissible(bytes);
    return bytes;
  }
  if (file.size > IMPORT_CSV_MAX_BYTES) {
    throw new FileTooLargeError("file_too_large", IMPORT_CSV_MAX_BYTES);
  }
  return decodeAdmittedCsv(new Uint8Array(await file.arrayBuffer()));
}

/**
 * Admission for the BULK (streaming) path, which never buffers the file for a full decode on the request
 * thread: the bulk drive worker parses CSV ONLY (streamParseCsv), so an .xlsx here is refused with an
 * honest 415 instead of being streamed to the store and garbage-parsed as CSV in the worker (12 §5: XLSX
 * is fast-path-only). CSV gets the byte cap + a prefix sniff (magic/NUL/BOM over the head of the file);
 * the full encoding gate for this path runs where the bytes are actually read — the worker's parse.
 */
export async function assertBulkUploadAdmissible(file: File): Promise<void> {
  if (isXlsxFile(file.name)) {
    throw new UnsupportedMediaTypeError(
      "Bulk import accepts CSV only — .xlsx files ride the standard import.",
    );
  }
  if (file.size > IMPORT_CSV_MAX_BYTES) {
    throw new FileTooLargeError("file_too_large", IMPORT_CSV_MAX_BYTES);
  }
  const prefix = new Uint8Array(await file.slice(0, IMPORT_CSV_SNIFF_PREFIX_BYTES).arrayBuffer());
  const bom = assertCsvPrefixAdmissible(prefix);
  // The bulk drive parser (streamParseCsv) decodes UTF-8 only — refuse a UTF-16 BOM honestly here rather
  // than stream it to the store and mojibake it in the worker (13 §1.3: never silent mojibake).
  if (bom === "utf-16le" || bom === "utf-16be") {
    throw new ImportValidationError(
      "Bulk import requires UTF-8 CSV — re-save the file as UTF-8 and re-upload.",
    );
  }
}
