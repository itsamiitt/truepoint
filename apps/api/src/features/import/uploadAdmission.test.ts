import { describe, expect, test } from "bun:test";
// uploadAdmission.test.ts — S-S1 request-side envelope (import-redesign 13 §1.2/§1.5; T-S7 class).
// CI-RUN: this sandbox cannot execute bun; these tests are the CI gate for the byte-count abort and the
// multipart hardening caps. The OVERSIZED-MULTIPART fixture is built as a real streaming Request whose
// body exceeds the ceiling — the parse must abort mid-stream with the typed 413, never buffer to the end.

import { FileTooLargeError, ImportValidationError } from "@leadwolf/types";
import { admittedImportFormData, assertBulkUploadAdmissible } from "./uploadAdmission.ts";

/** Build a multipart POST Request from FormData (the runtime sets the boundary header). */
function multipartRequest(form: FormData): Request {
  return new Request("http://localhost/api/v1/imports", { method: "POST", body: form });
}

function csvFile(content: string, name = "leads.csv"): File {
  return new File([content], name, { type: "text/csv" });
}

describe("admittedImportFormData — byte-count abort (13 §1.2)", () => {
  test("parses a small, well-formed import form", async () => {
    const form = new FormData();
    form.set("file", csvFile("Email\na@x.test\n"));
    form.set("sourceName", "csv");
    form.set("mapping", JSON.stringify({ email: "Email" }));
    const parsed = await admittedImportFormData(multipartRequest(form));
    expect(parsed.get("sourceName")).toBe("csv");
    expect(parsed.get("file")).toBeInstanceOf(File);
  });

  test("rejects a declared Content-Length above the ceiling BEFORE reading the body", async () => {
    const req = new Request("http://localhost/api/v1/imports", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(1024 * 1024),
      },
      body: "--x--\r\n",
    });
    await expect(admittedImportFormData(req, 1024)).rejects.toBeInstanceOf(FileTooLargeError);
  });

  test("aborts an over-ceiling STREAM mid-read (lying Content-Length)", async () => {
    // The oversized-multipart fixture: body bytes exceed the cap; no trustworthy Content-Length.
    const form = new FormData();
    form.set("file", csvFile(`Email\n${"a@x.test\n".repeat(50_000)}`)); // ~450 KB body
    form.set("sourceName", "csv");
    const req = multipartRequest(form);
    try {
      await admittedImportFormData(req, 64 * 1024); // 64 KiB ceiling
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(FileTooLargeError);
      expect((err as FileTooLargeError).status).toBe(413);
      expect((err as FileTooLargeError).code).toBe("file_too_large");
    }
  });
});

describe("admittedImportFormData — multipart hardening (13 §1.5)", () => {
  test("rejects too many parts", async () => {
    const form = new FormData();
    form.set("file", csvFile("Email\n"));
    for (let i = 0; i < 12; i++) form.set(`extra${i}`, "x");
    await expect(admittedImportFormData(multipartRequest(form))).rejects.toBeInstanceOf(
      ImportValidationError,
    );
  });

  test("rejects a SECOND file part (extras rejected, not ignored)", async () => {
    const form = new FormData();
    form.append("file", csvFile("Email\n"));
    form.append("file", csvFile("Email\n", "second.csv"));
    form.set("sourceName", "csv");
    await expect(admittedImportFormData(multipartRequest(form))).rejects.toBeInstanceOf(
      ImportValidationError,
    );
  });

  test("rejects a file part under any OTHER field name", async () => {
    const form = new FormData();
    form.set("file", csvFile("Email\n"));
    form.set("sneaky", csvFile("Email\n", "sneaky.csv"));
    await expect(admittedImportFormData(multipartRequest(form))).rejects.toBeInstanceOf(
      ImportValidationError,
    );
  });

  test("rejects an oversized text field", async () => {
    const form = new FormData();
    form.set("file", csvFile("Email\n"));
    form.set("mapping", "x".repeat(65 * 1024));
    await expect(admittedImportFormData(multipartRequest(form))).rejects.toBeInstanceOf(
      ImportValidationError,
    );
  });
});

describe("assertBulkUploadAdmissible — the (dark) bulk path is CSV-only", () => {
  test("admits a clean UTF-8 CSV", async () => {
    await expect(assertBulkUploadAdmissible(csvFile("Email\na@x.test\n"))).resolves.toBeUndefined();
  });

  test("rejects .xlsx on the bulk path with 415 (fast-path-only per 12 §5)", async () => {
    const f = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "big.xlsx");
    await expect(assertBulkUploadAdmissible(f)).rejects.toMatchObject({
      status: 415,
      code: "unsupported_media_type",
    });
  });

  test("rejects a ZIP renamed .csv by prefix magic", async () => {
    const f = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2])], "leads.csv");
    await expect(assertBulkUploadAdmissible(f)).rejects.toMatchObject({ status: 415 });
  });

  test("rejects a UTF-16 BOM (the drive parser is UTF-8-only)", async () => {
    const f = new File([new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x0a, 0x00])], "leads.csv");
    await expect(assertBulkUploadAdmissible(f)).rejects.toBeInstanceOf(ImportValidationError);
  });
});
