// keys.ts — the lists feature's TanStack Query key factory. Single source so every hook and every CRUD action
// reads/invalidates the SAME keys and the cache never fragments.
//
// There is deliberately NO per-list detail key: the lists API has no per-id GET, so the detail header selects
// its row out of the index query. One endpoint, one entry — a rename invalidates `index` and both the grid
// and the header update, which is what the hand-rolled `reload` callbacks were threaded through components
// to achieve.
export const listKeys = {
  all: ["lists"] as const,
  /** The workspace's lists (`GET /lists`). Also the source the detail header derives one row from. */
  index: () => ["lists", "index"] as const,
  /** One list's members — a single infinite-query entry holding every loaded keyset page. */
  members: (id: string) => ["lists", "members", id] as const,
};
