---
name: disk-cleanup-scan-en
description: |
  Scan a computer's disk usage: free space per drive, the largest folders and files, files or whole folders unused for a long time (default: not modified or opened for over a year), cleanable items such as caches, temp files, node_modules and installers in Downloads, plus duplicate large files. Produces a report that says, item by item, whether it is safe to delete. Read-only; selected items are moved to the Recycle Bin / Trash only after the user confirms.
  Trigger when the user writes in English and says "my disk is full", "C drive is running out of space", "what can I delete", "find files I haven't used in a long time", "what's taking up space", "clean up my hard drive", "disk usage analysis", or types /disk-cleanup-scan-en (optionally with a path or number of days).
  Do NOT trigger for recovering deleted files, formatting or partitioning disks, changing system settings (page file, hibernation file, restore points), or asking how big one single file is. For requests written in Chinese use disk-cleanup-scan.
user-invocable: true
---

# disk-cleanup-scan-en: disk usage and long-unused file scan

Goal: one report that shows where the space went, what has not been touched in a long time, and whether each item can be deleted. **The scan is read-only.** Every deletion needs the user's explicit yes.

## Step 1: decide the scope

Work it out from the user's words; if they say nothing, use the defaults (home folder, 365 days, >= 50 MB):

- A specific place -> `--path DIR` (repeatable). For a whole drive give its root, e.g. `--path "D:\\"` or `--path /`
- "not used in six months", "untouched for two years" -> `--days 180`, `--days 730`
- Only bigger files -> `--min-size 500` (MB)
- Duplicates -> add `--dupes` (reads files to hash them, slower)
- Paths to leave out -> `--exclude str1,str2`
- More rows per table -> `--top 40`

When the user says "the whole computer" or "the C drive", run the home folder first for a quick first result, then ask whether to scan the whole drive.

## Step 2: run the script

```bash
node <this skill's folder>/scripts/disk_scan.mjs --path "C:\\" --days 365
```

- Needs only Node.js 18.15 or later, no packages to install.
- A home folder usually takes from tens of seconds to a few minutes; a whole drive with millions of files can take 5-15 minutes. **Run it in the background** and wait for the completion notice instead of polling.
- Progress goes to stderr, the Markdown report to stdout; add `--json` to post-process it yourself.
- If the report is long, save it to a file first and read the important parts.

The script automatically skips `C:\Windows`, `System Volume Information`, `Recovery`, the page and hibernation files, macOS `/System`, Linux `/proc` `/sys` and similar system areas. It does not follow symlinks or junctions (to avoid double counting) and does not cross into other drives.

"Last used" = the newer of the modified time and the access time. If Windows has access-time updates turned off, the top of the report says so, and only the modified time is available.

When the "long unused" tables are empty, look at the "By last use" table first: if the computer or drive is less than a year old (everything was copied or extracted onto it recently), this is expected. Run again with `--days 180` or `--days 90` instead of telling the user there is nothing to delete. If one folder is huge and its contents are unclear, scan it on its own with `--path THAT_FOLDER` to go one level deeper.

## Step 3: write the conclusion

Show the user the key tables (disk overview, largest folders, long-unused items, cleanable categories), then sort things into three plain-language groups:

1. **Safe to clear** (caches, temp files, Recycle Bin, crash dumps): apps rebuild them, no data is lost.
   - Browser caches should be cleared from the browser's settings, not by deleting folders (they are locked while the browser runs).
   - For Windows temp files and update leftovers, suggest Settings -> System -> Storage -> Temporary files, or Disk Cleanup, and let the user run it.
2. **Rebuildable, at a cost** (node_modules, .venv, .next, .godot/imported, ...): deleting means running `npm install` or a rebuild next time. Only recommend deleting them in **projects that have not been touched in a long time**.
3. **Your call** (long-unused large files, whole long-unused folders, installers and archives in Downloads, duplicates): list each with path, size and how long unused, and say what it looks like (e.g. "a 3-year-old Windows ISO you can download again", "an old phone backup", "a game installer").

Give an approximate saving for each group. Also say clearly:

- **Items labeled "System, do not delete by hand" must not be touched** (Windows, ProgramData, AppData\Microsoft, /System, ...).
- **Items labeled "App, use uninstall"**: remove them via Settings -> Apps, never by deleting folders inside Program Files.
- **Never delete git repositories (.git).**
- **OneDrive / cloud-synced folders**: deleting there also deletes the cloud copy. To save local space, use "Free up space" (keep online only) instead.
- If the hibernation file, page file or system restore points take a lot of space, only tell the user they can adjust these in system settings themselves; do not change them for the user.

## Step 4: when the user decides what to delete

**Never delete permanently** (no `Remove-Item`, `rm`, `del`, `rd`, no emptying the Recycle Bin / Trash). Only move items to the Recycle Bin / Trash:

1. List the paths to delete with their sizes and the total, and ask the user to confirm once.
2. After confirmation, check each path exists and is not in a system area, then move it to the Recycle Bin / Trash:

   Windows (PowerShell):
   ```powershell
   Add-Type -AssemblyName Microsoft.VisualBasic
   $p = 'D:\Old stuff\some-file.iso'
   if (Test-Path -LiteralPath $p -PathType Container) {
     [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
   } elseif (Test-Path -LiteralPath $p) {
     [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
   }
   ```
   macOS: `osascript -e 'tell application "Finder" to delete POSIX file "/path/to/file"'`
   Linux: `gio trash /path/to/file` (or `trash-put` if gio is missing)

3. **If a file is bigger than the Recycle Bin can hold**, Windows pops up a "permanently delete?" dialog: do not click it for the user. Ask them to handle it themselves, or move the file into a `_to_delete_DATE` folder on the same drive so they can check it and delete it themselves later.
4. Afterwards, report what was moved and the total, and remind the user: "Space is only freed once the Recycle Bin is emptied. Please check it and empty it yourself."

## Notes

- All sizes in the report are **on-disk sizes** (Explorer's "Size on disk"), not the labeled file size. Emulator and virtual machine disks (.img, .vhdx, .vmdk) are often sparse files: a disk image labeled 512 GB may occupy only a few GB. The report marks such files as "labeled X, sparse/compressed"; quote the on-disk size to the user rather than alarming them with the labeled size.
- OneDrive cloud-only files occupy 0 bytes on disk and do not show up in the large-file lists.
- "Unreadable" usually means insufficient permissions (other users' folders, system folders). Do not rerun as administrator unless the user asks.
- Do not open documents to read their contents; judge by path, name, size and date only. If a path does not tell you what something is, ask the user.
