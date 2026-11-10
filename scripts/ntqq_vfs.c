/* Read the NTQQ-prefixed main database through SQLCipher's existing Windows
 * VFS. WAL offsets, shared-memory mapping and interprocess locks stay native. */
#include "sqlite3ext.h"
#include <stdint.h>
#include <string.h>
SQLITE_EXTENSION_INIT1

enum { prefix_size = 1024 };
static sqlite3_vfs *windows_vfs;
static sqlite3_vfs ntqq_vfs;

typedef struct {
    sqlite3_io_methods methods;
    const sqlite3_io_methods *windows;
} MainMethods;

static MainMethods *main_methods(sqlite3_file *file) {
    return (MainMethods *)file->pMethods;
}

static int read_main(sqlite3_file *file, void *buf, int amount, sqlite3_int64 offset) {
    if (offset < 0 || offset > INT64_MAX - prefix_size) return SQLITE_IOERR_READ;
    return main_methods(file)->windows->xRead(file, buf, amount, offset + prefix_size);
}

static int size_main(sqlite3_file *file, sqlite3_int64 *size) {
    int rc = main_methods(file)->windows->xFileSize(file, size);
    if (rc != SQLITE_OK) return rc;
    if (*size < prefix_size) return SQLITE_NOTADB;
    *size -= prefix_size;
    return SQLITE_OK;
}

static int unmap_main(sqlite3_file *file, int delete_flag) {
    (void)delete_flag;
    return main_methods(file)->windows->xShmUnmap(file, 0);
}

static int deny_delete(sqlite3_vfs *vfs, const char *name, int sync_dir) {
    (void)vfs; (void)name; (void)sync_dir;
    return SQLITE_READONLY;
}

static int open_readonly(sqlite3_vfs *vfs, const char *name, sqlite3_file *file, int flags, int *out) {
    (void)vfs;
    if (!name || !(flags & (SQLITE_OPEN_MAIN_DB | SQLITE_OPEN_WAL))) return SQLITE_READONLY;
    if ((flags & SQLITE_OPEN_MAIN_DB) && (!(flags & SQLITE_OPEN_READONLY) ||
            !sqlite3_uri_boolean(name, "readonly_shm", 0) || sqlite3_uri_boolean(name, "immutable", 0))) {
        return SQLITE_READONLY;
    }
    flags &= ~(SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_DELETEONCLOSE);
    flags |= SQLITE_OPEN_READONLY;
    int rc = windows_vfs->xOpen(windows_vfs, name, file, flags, out);
    if (rc != SQLITE_OK || (flags & SQLITE_OPEN_WAL)) return rc;

    char prefix[16];
    rc = file->pMethods->xRead(file, prefix, sizeof(prefix), 0);
    if (rc != SQLITE_OK || memcmp(prefix, "SQLite header 3", sizeof(prefix)) != 0) {
        file->pMethods->xClose(file);
        file->pMethods = NULL;
        return rc == SQLITE_OK ? SQLITE_NOTADB : rc;
    }
    /* Keep the native winFile at the original address for all other callbacks. */
    size_t tail = ((size_t)windows_vfs->szOsFile + 7) & ~(size_t)7;
    MainMethods *m = (MainMethods *)((unsigned char *)file + tail);
    m->windows = file->pMethods;
    m->methods = *m->windows;
    m->methods.iVersion = 2; /* No mmap reads at unshifted main-file offsets. */
    m->methods.xRead = read_main;
    m->methods.xFileSize = size_main;
    m->methods.xShmUnmap = unmap_main;
    m->methods.xFetch = NULL;
    m->methods.xUnfetch = NULL;
    file->pMethods = &m->methods;
    return SQLITE_OK;
}

__declspec(dllexport) int sqlite3_extension_init(sqlite3 *db, char **error, const sqlite3_api_routines *api) {
    (void)db; (void)error;
    SQLITE_EXTENSION_INIT2(api);
    sqlite3_vfs *existing = sqlite3_vfs_find("ntqq_readonly");
    if (existing) return existing == &ntqq_vfs ? SQLITE_OK : SQLITE_ERROR;
    windows_vfs = sqlite3_vfs_find("win32");
    if (!windows_vfs) return SQLITE_CANTOPEN;
    ntqq_vfs = *windows_vfs;
    ntqq_vfs.zName = "ntqq_readonly";
    ntqq_vfs.pNext = NULL;
    ntqq_vfs.szOsFile = ((windows_vfs->szOsFile + 7) & ~7) + (int)sizeof(MainMethods);
    ntqq_vfs.xOpen = open_readonly;
    ntqq_vfs.xDelete = deny_delete;
    int rc = sqlite3_vfs_register(&ntqq_vfs, 0);
    return rc == SQLITE_OK ? SQLITE_OK_LOAD_PERMANENTLY : rc;
}
