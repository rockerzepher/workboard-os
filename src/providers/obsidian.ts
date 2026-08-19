export type ObsidianNote = {
  sourceId: string;
  path: string;
  title: string;
  excerpt: string;
  tags: string[];
};

export type ObsidianVaultPreview = {
  vaultName: string;
  noteCount: number;
  notes: ObsidianNote[];
};

type ObsidianFileEntry = { kind: "file"; name: string; getFile: () => Promise<File> };
type ObsidianDirectoryEntry = { kind: "directory"; name: string; values: () => AsyncIterable<ObsidianFileEntry | ObsidianDirectoryEntry> };
export type ObsidianDirectoryHandle = {
  kind: "directory";
  name: string;
  values: () => AsyncIterable<ObsidianFileEntry | ObsidianDirectoryEntry>;
  queryPermission?: (descriptor: { mode: "read" }) => Promise<PermissionState>;
};

declare global {
  interface Window {
    showDirectoryPicker?: () => Promise<ObsidianDirectoryHandle>;
  }
}

const OBSIDIAN_DB_NAME = "workboard-connections";
const OBSIDIAN_STORE_NAME = "handles";
const OBSIDIAN_HANDLE_KEY = "obsidian-vault";

function openHandleDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(OBSIDIAN_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(OBSIDIAN_STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local connection storage"));
  });
}

export async function saveObsidianVaultHandle(handle: ObsidianDirectoryHandle) {
  const db = await openHandleDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(OBSIDIAN_STORE_NAME, "readwrite").objectStore(OBSIDIAN_STORE_NAME).put(handle, OBSIDIAN_HANDLE_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Could not save the Obsidian vault selection"));
  });
  db.close();
}

export async function loadObsidianVaultHandle() {
  const db = await openHandleDb();
  const handle = await new Promise<ObsidianDirectoryHandle | undefined>((resolve, reject) => {
    const request = db.transaction(OBSIDIAN_STORE_NAME, "readonly").objectStore(OBSIDIAN_STORE_NAME).get(OBSIDIAN_HANDLE_KEY);
    request.onsuccess = () => resolve(request.result as ObsidianDirectoryHandle | undefined);
    request.onerror = () => reject(request.error ?? new Error("Could not read the saved Obsidian vault selection"));
  });
  db.close();
  return handle;
}

export async function removeObsidianVaultHandle() {
  const db = await openHandleDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(OBSIDIAN_STORE_NAME, "readwrite").objectStore(OBSIDIAN_STORE_NAME).delete(OBSIDIAN_HANDLE_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Could not remove the saved Obsidian vault selection"));
  });
  db.close();
}

function titleFromMarkdown(path: string, markdown: string) {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  return path.split("/").pop()?.replace(/\.md$/i, "") ?? "Untitled note";
}

function tagsFromMarkdown(markdown: string) {
  const frontmatterTags = markdown.match(/^tags:\s*\[([^\]]*)\]/m)?.[1];
  if (frontmatterTags) return frontmatterTags.split(",").map((tag) => tag.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean).slice(0, 6);
  return [...markdown.matchAll(/(^|\s)#([a-zA-Z0-9/_-]+)/g)].map((match) => match[2]).slice(0, 6);
}

function excerptFromMarkdown(markdown: string) {
  const excerpt = markdown
    .replace(/^---[\s\S]*?---\s*/m, "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/^#+\s+/, "").replace(/[*_`]/g, "").trim())
    .find((paragraph) => paragraph.length > 0);
  return excerpt ? `${excerpt.slice(0, 156)}${excerpt.length > 156 ? "…" : ""}` : "No note excerpt available.";
}

export async function readObsidianVault(files: File[], vaultNameOverride?: string): Promise<ObsidianVaultPreview> {
  const markdownFiles = files.filter((file) => file.name.toLowerCase().endsWith(".md"));
  const notes = await Promise.all(markdownFiles.map(async (file) => {
    const typedFile = file as File & { webkitRelativePath?: string };
    const path = typedFile.webkitRelativePath || file.name;
    const markdown = await file.text();
    return {
      sourceId: `obsidian:${path}`,
      path,
      title: titleFromMarkdown(path, markdown),
      excerpt: excerptFromMarkdown(markdown),
      tags: tagsFromMarkdown(markdown),
    } satisfies ObsidianNote;
  }));
  const vaultName = vaultNameOverride ?? (markdownFiles[0] ? (markdownFiles[0] as File & { webkitRelativePath?: string }).webkitRelativePath?.split("/")[0] ?? "Selected vault" : "Selected vault");
  return { vaultName, noteCount: notes.length, notes: notes.sort((a, b) => a.path.localeCompare(b.path)) };
}

async function collectMarkdownFiles(directory: ObsidianDirectoryHandle, prefix = "") {
  const files: File[] = [];
  for await (const entry of directory.values()) {
    if (entry.kind === "file" && entry.name.toLowerCase().endsWith(".md")) {
      const file = await entry.getFile();
      Object.defineProperty(file, "webkitRelativePath", { value: `${directory.name}/${prefix}${entry.name}` });
      files.push(file);
    } else if (entry.kind === "directory" && ![".obsidian", "templates", "attachments"].includes(entry.name.toLowerCase())) {
      files.push(...await collectMarkdownFiles(entry, `${prefix}${entry.name}/`));
    }
  }
  return files;
}

export async function readObsidianDirectory(handle: ObsidianDirectoryHandle) {
  return readObsidianVault(await collectMarkdownFiles(handle), handle.name);
}
