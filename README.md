# Support Knowledge Hub

A self-support page for troubleshooting: load your OneNote notes, type a few words, get
autocomplete suggestions and the matching knowledge entries.

## Run it

```
npm install
npm start
```

- Search page: http://localhost:3000
- Admin page (upload / delete notes): http://localhost:3000/admin

## Where the notes live

Uploaded files are saved in the [`onenotes/`](onenotes) folder of this repo (sub-folders are
allowed and can be used as notebooks). The search index is built in memory from that folder
every time the server starts, so the folder is the single source of truth. You can also copy
files into it by hand and press **Re-index all** on the admin page.

To keep the notes in the repo, commit and push the folder after uploading, or let the server
do it for you with `AUTO_COMMIT=1` / `AUTO_PUSH=1` (see below).

## Supported note formats

| Format | How to get it from OneNote | What is kept |
| --- | --- | --- |
| `.docx` (recommended) | File → Export → Word Document | Text, headings, tables, lists, images. One entry per heading. |
| `.mht` | File → Export → Single File Web Page | Text, tables, images. |
| `.pdf` | File → Export → PDF | Text only. One entry per page. |
| `.one` | The section file itself | Plain text only, best effort. The format is proprietary, so formatting, images and page titles are lost and some noise can appear. |
| `.html`, `.md`, `.txt` | Any other source | Text; headings split entries. |

Each heading (Heading 1–3) becomes its own searchable entry, so well-structured notes give
more precise results.

## Settings (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on. |
| `ADMIN_PASSWORD` | not set | Password for the admin page. If not set, the admin page is open to anyone who can reach the server. |
| `NOTES_DIR` | `onenotes` | Folder holding the note files. |
| `AUTO_COMMIT` | off | Set to `1` to `git commit` the notes folder after every upload or delete. |
| `AUTO_PUSH` | off | Set to `1` to commit and also `git push`. |
| `MAX_UPLOAD_MB` | `95` | Upload size limit per file (GitHub rejects files over 100 MB). |

Example: `ADMIN_PASSWORD=choose-one AUTO_PUSH=1 npm start`
