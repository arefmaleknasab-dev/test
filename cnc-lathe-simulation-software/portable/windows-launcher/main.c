#define UNICODE
#define _UNICODE

#include <windows.h>
#include <shellapi.h>
#include <wchar.h>

static const wchar_t *APP_FILE = L"KharratCode.html";

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR commandLine, int showCommand) {
    (void)instance;
    (void)previous;
    (void)commandLine;
    (void)showCommand;

    wchar_t path[32768];
    DWORD length = GetModuleFileNameW(NULL, path, (DWORD)(sizeof(path) / sizeof(path[0])));
    if (length == 0 || length >= (DWORD)(sizeof(path) / sizeof(path[0]))) {
        return 1;
    }

    wchar_t *slash = wcsrchr(path, L'\\');
    if (slash == NULL) {
        return 1;
    }
    slash[1] = L'\0';
    if (wcslen(path) + wcslen(APP_FILE) + 1 >= sizeof(path) / sizeof(path[0])) {
        return 1;
    }
    wcscat(path, APP_FILE);

    if (GetFileAttributesW(path) == INVALID_FILE_ATTRIBUTES) {
        MessageBoxW(
            NULL,
            L"KharratCode.html was not found. Extract the complete ZIP and keep both files together.",
            L"KharratCode Portable",
            MB_OK | MB_ICONERROR
        );
        return 1;
    }

    HINSTANCE result = ShellExecuteW(NULL, L"open", path, NULL, NULL, SW_SHOWNORMAL);
    if ((INT_PTR)result <= 32) {
        MessageBoxW(
            NULL,
            L"Windows could not open the bundled application in the default browser.",
            L"KharratCode Portable",
            MB_OK | MB_ICONERROR
        );
        return 1;
    }
    return 0;
}
