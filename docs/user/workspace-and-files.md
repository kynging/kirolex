# Workspace and files

[← Back to contents](README.md)

## Split panes

You can show up to four chats at once. Every pane is a full chat with its own composer, queue,
attachments and model. *Every pane is a full chat, each with its own composer, queue and attachments.*

**Choose the grid** in **Settings → 💬 会话** (*Chats*) → **Split grid (click a chat in the sidebar to
add it; every pane has its own composer)**:

- **1 × 1 (no split)**
- **1 row × 2 cols (side by side)**: the default
- **2 rows × 1 col (stacked)**
- **2 rows × 2 cols (maximum)**

**Put a chat in a pane:**

- click a chat in the sidebar. If every pane is taken, it replaces the pane you used last; or
- right-click a chat → **⇆ Add to split**.

An empty pane says **This pane is empty.** and shows **Click a chat on the left to fill this pane**
or **{n} more can go here**. If you add a second chat while the grid is 1 × 1, KiroLex switches to
1 row × 2 cols.

**Remove a pane:** click the ✕ at its top right (**Remove from split view**), or right-click the chat
→ **⇆ Remove from split**.

**Resize:** drag the divider between panes. Double-click a divider to even them out again. Sizes are
remembered separately for each grid shape. To lock the panes at equal sizes, turn off **Draggable
pane dividers** under **Settings → 🧪 开关** (*Switches*). The dividers then say
**Pane dragging is turned off in Settings**.

## The workspace browser

The workspace browser lets you browse files on your computer and open them inside KiroLex. It does not
depend on any chat, so it works even when no agent is connected.

- **Open it:** the folder button at the bottom of the sidebar (**Open workspace files** /
  **Close workspace files**). The panel is titled **Workspace**.
- **Navigate:** click a folder to enter it. Use **Up one level** to go back, and **Refresh** to
  reload. The current path is shown at the top.
- **Filter:** type in **Filter in this directory…** to narrow the current folder by name. This is not
  case-sensitive and does not search subfolders. Enter opens the only remaining match, and Esc or
  ✕ (**Clear (Esc)**) clears the filter.
- **Open a file:** click it. It opens in the file viewer on the right.

KiroLex remembers the last folder you browsed.

## The file viewer

Files you open from the workspace browser or from a chat (file links, **📝 Changed files**) open as
tabs in a panel on the right.

- **Tabs:** up to 12. Opening a file that is already open switches to its tab. Close a tab with its
  ✕ (**Close tab**), a middle-click or **Ctrl+W** (⌘+W). **Ctrl+1…9** (⌘+1…9) switches tabs.
  A tab marked ⚠ and struck through means the file was deleted or renamed. The viewer then shows the
  last content it read (*This file is no longer on disk (deleted or renamed). What is shown below is
  the last content read.*).
- **Top bar:** **⟳ 刷新** (*Refresh*) re-reads the file from disk, **📂 打开位置** (*Show in folder*)
  shows it in Finder or Explorer, and ✕ (**Close panel**) closes the viewer.
- **Rendered or raw:** Markdown is rendered and code is syntax-highlighted. Switch with **◎ Raw** /
  **◉ Rendered**. Minified JSON is shown formatted, and **Raw** shows it as it is.
- **Find:** click in the viewer and press **Ctrl+F** (⌘+F) for **Find in this file…**. Some file types
  can't be searched (*This file type does not support search*).
- **Width:** drag the panel's edge (**Drag to resize width**), or use ▶ / ◀ to fold and unfold it.
- Very large files are shown only up to the first 512 KB.
- File types KiroLex can't preview open in your system's default app. PDF and Office documents are
  the exception (see [below](#pdf-and-office-documents)).

## Changed files

After a turn in which the agent edited files, the chat shows a **📝 Changed files** panel with the
number of files. Each row shows:

- how the file was changed, and its name (click the name to open the file in the viewer);
- lines added and removed;
- a **diff** button that shows the new text (click **Collapse** to hide it).

Only files the agent actually changed are listed, not files it merely read. A **struck-through** name
means the file no longer exists, so it can't be opened, but its diff is still shown. In
[remote chats](remote-sessions.md) the panel carries a 🌐 host badge.

## Commenting on a file and letting the agent apply it

For text and Markdown files, you can mark up the file and have the agent make the changes:

1. Open the file from a chat (for example from **📝 Changed files** or a file link), so the viewer
   knows which chat it belongs to.
2. Click **💬 comment** in the viewer's toolbar. It is not available in raw view or for files too
   large to show in full.
3. For each block of text, use:
   - **💬**: write a comment on the block;
   - **✎**: edit the text directly;
   - **＋**: add new content after the block;
   - **✕**: mark the block for deletion (**↩** undoes it).
4. Confirm each comment with **✓ 确认** (*Confirm*). Your marks build up, and the footer shows what is
   marked (已标记：… / *Marked: …*).
5. Click **提交** (*Submit*), or press Ctrl+Enter (⌘+Enter), to send all marks at once.

The changes are made by **the chat the file was opened from**. If that chat is busy, they wait their
turn. Before writing, KiroLex backs the file up to `~/.kirolex/backups/review-files/`. A tab with no
owning chat is view-only.

Blocks the agent has just changed are highlighted with **AI 刚改过** (*AI just changed this*) or
**AI 删了一段** (*AI deleted a block*). Each one has an **撤销** (*Undo*) button that reverts only that
block.

### PDF and Office documents

KiroLex can preview **PDF**, and also **pptx, ppt, ppsx, pps, odp, docx, doc, odt and rtf**. Office
files are converted to PDF with **LibreOffice**. The first conversion is slower, and after that it is
cached. If LibreOffice is not installed, the viewer explains this and offers **复制命令**
(*Copy command*) for the install command:

| OS | Install command |
|---|---|
| Windows | `winget install --id TheDocumentFoundation.LibreOffice -e` |
| macOS | `brew install --cask libreoffice` |
| Linux | `sudo apt install libreoffice` |

Slide decks get extra buttons on each page: **💬 版面** (*Layout*), **🗒 讲稿** (*Speaker notes*),
**＋ 加页** (*Add page*) and **✕ 删掉这一页** (*Delete this page*). Editing a `.pptx` file in place also
needs Python with `python-pptx`.
