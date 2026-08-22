// bindLimit.ts — slice a multi-row INSERT so it cannot exceed PostgreSQL's bind-parameter ceiling.
//
// The wire protocol addresses bind parameters with a 16-bit count, so a single statement carries at most
// 65,535 of them; postgres.js refuses at 65,534 with MAX_PARAMETERS_EXCEEDED. Drizzle emits ONE statement for
// `.values(array)`, binding a parameter per present key per row — so a multi-row insert has a hard row ceiling
// of `65534 / keysPerRow`, and it is low enough to matter: a contact binds ~19 keys, which caps a statement at
// roughly 3,400 rows.
//
// THIS EXISTS BECAUSE THE IMPORTER EXCEEDED IT. `runBulkImport` plans bands of CHUNK_ROWS = 10_000 and
// `bulkProcessChunk` handed each whole band to `contactRepository.insertBatch` and
// `sourceImportRepository.appendBatch` as a single statement — ~190,000 and ~80,000 parameters respectively,
// both far past the ceiling. Every bulk import of a chunk with more than ~3,400 new contacts threw. Nobody had
// hit it because bulk import ships dark behind BULK_IMPORT_ENABLED, and the soak suite written to catch
// exactly this had never executed: it gates on NIGHTLY_SOAK, and no workflow set that variable until now.
//
// The width is derived from the DATA, never hardcoded as a row count. Drizzle builds one column list for the
// whole VALUES clause, so the cost per row is the size of the widest value object in the batch — and a
// hardcoded row limit silently becomes wrong the day a column is added.

/** postgres.js throws at 65_534; 60_000 leaves headroom for anything the driver binds beyond the values. */
const SAFE_PARAMETER_BUDGET = 60_000;

/**
 * Split `rows` into slices that each stay under the bind-parameter budget.
 *
 * Returns a single slice (the original array) whenever it already fits, so the common small-batch case issues
 * exactly one statement and allocates nothing extra. Callers MUST concatenate results in order — a single
 * INSERT's RETURNING preserves VALUES order, and the slices preserve it across statements, which is what lets
 * callers keep relying on `result[i]` matching `rows[i]`.
 */
export function sliceForBindLimit<T extends object>(rows: readonly T[]): T[][] {
  if (rows.length === 0) return [];

  // The widest row decides the cost: Drizzle's column list is the union, and a narrower row still occupies a
  // slot per column (DEFAULT for the keys it lacks). Max, not average — averaging under-counts the tail.
  let paramsPerRow = 1;
  for (const row of rows) {
    const keys = Object.keys(row).length;
    if (keys > paramsPerRow) paramsPerRow = keys;
  }

  const rowsPerStatement = Math.max(1, Math.floor(SAFE_PARAMETER_BUDGET / paramsPerRow));
  if (rows.length <= rowsPerStatement) return [rows as T[]];

  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += rowsPerStatement) {
    out.push(rows.slice(i, i + rowsPerStatement) as T[]);
  }
  return out;
}
