// InboxPage.tsx — the Inbox destination (11 §4.4): a Tabs switch between the unified reply threads and tasks.
// Composition only; each tab owns its own data + states.
"use client";

import { Tabs } from "@leadwolf/ui";
import { useState } from "react";
import styles from "../inbox.module.css";
import { TasksPanel } from "./TasksPanel";
import { ThreadList } from "./ThreadList";

const TABS = [
  { value: "replies", label: "Replies" },
  { value: "tasks", label: "Tasks" },
];

export function InboxPage() {
  const [tab, setTab] = useState("replies");
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Inbox</h1>
        <p className={styles.subtitle}>Unified replies + tasks</p>
      </header>
      <Tabs items={TABS} value={tab} onChange={setTab} aria-label="Inbox sections" />
      <div className={styles.body}>{tab === "replies" ? <ThreadList /> : <TasksPanel />}</div>
    </div>
  );
}
