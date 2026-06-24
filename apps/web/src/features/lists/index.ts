// Public surface of the lists feature slice — the two page components the (shell)/lists routes render. Mirrors
// the prospect slice barrel: named exports of the public components; internals (hooks/api/dialogs) stay private.
// (The shared "add to list" picker lives in the prospect slice, next to the membership client it uses, so the
// dependency stays one-way: lists → prospect, never the reverse.)
export { ListsPage } from "./components/ListsPage";
export { ListDetailPage } from "./components/ListDetailPage";
