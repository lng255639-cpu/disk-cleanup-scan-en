# Disk Cleanup Scan

A [Claude Code](https://claude.com/claude-code) skill that scans your disks and tells you where the space went, which files you have not used in a long time, and what you can delete.

- Total / used / free space per drive
- Largest folders (levels 1-3) and largest files
- **Long-unused** large files, and whole folders nothing has touched (default: not modified or opened for over 365 days)
- Space by last-use time
- Cleanable categories: Recycle Bin, Temp, browser caches, npm / pip / uv and other package caches, crash dumps, node_modules, Python virtualenvs, build output, installers and archives in Downloads
- Extensions using the most space
- Optional: large files with identical content

Every row gets advice: "Cache, safe to clear", "Rebuildable", "Your call", "App, use uninstall", "System, do not delete by hand".

**The scan is read-only.** Only after you confirm what to delete does Claude move those items to the Recycle Bin / Trash (never a permanent delete, and it never empties the Recycle Bin for you).

> 中文版：[disk-cleanup-scan](https://github.com/lng255639-cpu/disk-cleanup-scan). Each edition only responds to requests in its own language, so you can install both.

---

## Install

Put the whole folder in Claude Code's skills directory:

```bash
git clone https://github.com/lng255639-cpu/disk-cleanup-scan-en ~/.claude/skills/disk-cleanup-scan-en
```

Requirements: Node.js 18.15 or later (no packages to install). Works on Windows, macOS and Linux.

## Use

In Claude Code type:

```
/disk-cleanup-scan-en
```

or just say:

- "My C drive is almost full, what can I delete?"
- "Find large files on D: I haven't used in two years"
- "What's taking up all my space?"
- "Find duplicate video files"

## Run the script directly

```bash
node scripts/disk_scan.mjs --path "C:\\" --days 365 --min-size 50
```

| Option | Meaning | Default |
|---|---|---|
| `--path` | Folder or drive root to scan, repeatable | home folder |
| `--days` | Days without use that count as "long unused" | 365 |
| `--min-size` | Threshold for the large-file lists (MB) | 50 |
| `--top` | Rows per table | 20 |
| `--depth` | Folder levels to aggregate | 3 |
| `--dupes` | Find large files with identical content (slower) | off |
| `--exclude` | Skip paths containing these strings, comma-separated | none |
| `--json` | Output JSON | off |

## Limitations

- "Last used" = the newer of the modified and access times. If Windows has access-time updates turned off (`fsutil behavior query disablelastaccess` returns 1 or 3), only the modified time is available, and the report says so.
- All sizes are on-disk sizes ("Size on disk"), so sparse files (emulator / VM virtual disks), NTFS-compressed files and OneDrive cloud-only files are not overstated; files whose labeled size differs a lot are annotated.
- Skips Windows, System Volume Information, the page / hibernation files and other system areas; does not follow symlinks or junctions; does not cross drives.
- Folders without read permission are skipped and counted.

## License

MIT
