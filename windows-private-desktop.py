"""Run one process tree on a private Windows desktop.

The launcher inherits stdin/stdout/stderr from its parent, creates a desktop
that is never switched into view, starts the requested command there with no
console window, waits for the root process, and returns its exit code.  Every
GUI or console descendant inherits the private desktop, so an inner Codex
PowerShell cannot flash on the user's interactive desktop.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import os
import subprocess
import sys
import uuid


CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_UNICODE_ENVIRONMENT = 0x00000400
CREATE_NO_WINDOW = 0x08000000
GENERIC_ALL = 0x10000000
INFINITE = 0xFFFFFFFF
STARTF_USESHOWWINDOW = 0x00000001
STARTF_USESTDHANDLES = 0x00000100
SW_HIDE = 0
UOI_NAME = 2


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("lpReserved", wintypes.LPWSTR),
        ("lpDesktop", wintypes.LPWSTR),
        ("lpTitle", wintypes.LPWSTR),
        ("dwX", wintypes.DWORD),
        ("dwY", wintypes.DWORD),
        ("dwXSize", wintypes.DWORD),
        ("dwYSize", wintypes.DWORD),
        ("dwXCountChars", wintypes.DWORD),
        ("dwYCountChars", wintypes.DWORD),
        ("dwFillAttribute", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("wShowWindow", wintypes.WORD),
        ("cbReserved2", wintypes.WORD),
        ("lpReserved2", ctypes.POINTER(wintypes.BYTE)),
        ("hStdInput", wintypes.HANDLE),
        ("hStdOutput", wintypes.HANDLE),
        ("hStdError", wintypes.HANDLE),
    ]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("hProcess", wintypes.HANDLE),
        ("hThread", wintypes.HANDLE),
        ("dwProcessId", wintypes.DWORD),
        ("dwThreadId", wintypes.DWORD),
    ]


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
user32 = ctypes.WinDLL("user32", use_last_error=True)

user32.CreateDesktopW.argtypes = [
    wintypes.LPCWSTR,
    wintypes.LPCWSTR,
    ctypes.c_void_p,
    wintypes.DWORD,
    wintypes.DWORD,
    ctypes.c_void_p,
]
user32.CreateDesktopW.restype = wintypes.HANDLE
user32.CloseDesktop.argtypes = [wintypes.HANDLE]
user32.CloseDesktop.restype = wintypes.BOOL
user32.GetThreadDesktop.argtypes = [wintypes.DWORD]
user32.GetThreadDesktop.restype = wintypes.HANDLE
user32.GetUserObjectInformationW.argtypes = [
    wintypes.HANDLE,
    ctypes.c_int,
    ctypes.c_void_p,
    wintypes.DWORD,
    ctypes.POINTER(wintypes.DWORD),
]
user32.GetUserObjectInformationW.restype = wintypes.BOOL
kernel32.GetCurrentThreadId.argtypes = []
kernel32.GetCurrentThreadId.restype = wintypes.DWORD
kernel32.CreateProcessW.argtypes = [
    wintypes.LPCWSTR,
    wintypes.LPWSTR,
    ctypes.c_void_p,
    ctypes.c_void_p,
    wintypes.BOOL,
    wintypes.DWORD,
    ctypes.c_void_p,
    wintypes.LPCWSTR,
    ctypes.POINTER(STARTUPINFOW),
    ctypes.POINTER(PROCESS_INFORMATION),
]
kernel32.CreateProcessW.restype = wintypes.BOOL
kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel32.WaitForSingleObject.restype = wintypes.DWORD
kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
kernel32.GetExitCodeProcess.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL


def _windows_error(operation: str) -> OSError:
    code = ctypes.get_last_error()
    return OSError(code, f"{operation}: {ctypes.FormatError(code)}")


def _stdio_handle(stream: object) -> int:
    import msvcrt

    return msvcrt.get_osfhandle(stream.fileno())


def _current_desktop_name() -> str:
    desktop = user32.GetThreadDesktop(kernel32.GetCurrentThreadId())
    if not desktop:
        raise _windows_error("GetThreadDesktop")
    needed = wintypes.DWORD()
    user32.GetUserObjectInformationW(desktop, UOI_NAME, None, 0, ctypes.byref(needed))
    if needed.value == 0:
        raise _windows_error("GetUserObjectInformationW(size)")
    buffer = ctypes.create_unicode_buffer((needed.value // ctypes.sizeof(ctypes.c_wchar)) + 1)
    if not user32.GetUserObjectInformationW(
        desktop, UOI_NAME, buffer, ctypes.sizeof(buffer), ctypes.byref(needed)
    ):
        raise _windows_error("GetUserObjectInformationW(name)")
    return buffer.value


def run(argv: list[str]) -> int:
    if os.name != "nt":
        raise RuntimeError("windows-private-desktop.py only supports Windows")
    if not argv:
        raise ValueError("an executable and optional arguments are required")

    desktop_name = f"mcp-dog-{os.getpid()}-{uuid.uuid4().hex}"
    desktop = user32.CreateDesktopW(desktop_name, None, None, 0, GENERIC_ALL, None)
    if not desktop:
        raise _windows_error("CreateDesktopW")

    process = PROCESS_INFORMATION()
    startup = STARTUPINFOW()
    startup.cb = ctypes.sizeof(STARTUPINFOW)
    startup.lpDesktop = f"winsta0\\{desktop_name}"
    startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES
    startup.wShowWindow = SW_HIDE
    startup.hStdInput = _stdio_handle(sys.stdin)
    startup.hStdOutput = _stdio_handle(sys.stdout)
    startup.hStdError = _stdio_handle(sys.stderr)
    command_line = ctypes.create_unicode_buffer(subprocess.list2cmdline(argv))
    flags = CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW

    try:
        created = kernel32.CreateProcessW(
            None,
            command_line,
            None,
            None,
            True,
            flags,
            None,
            os.getcwd(),
            ctypes.byref(startup),
            ctypes.byref(process),
        )
        if not created:
            raise _windows_error("CreateProcessW")
        kernel32.CloseHandle(process.hThread)
        kernel32.WaitForSingleObject(process.hProcess, INFINITE)
        exit_code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(process.hProcess, ctypes.byref(exit_code)):
            raise _windows_error("GetExitCodeProcess")
        return int(exit_code.value)
    finally:
        if process.hProcess:
            kernel32.CloseHandle(process.hProcess)
        user32.CloseDesktop(desktop)


def main() -> int:
    try:
        if sys.argv[1:] == ["--print-desktop"]:
            print(_current_desktop_name(), flush=True)
            return 0
        if sys.argv[1:] == ["--spawn-nested-desktop"]:
            nested = subprocess.run(
                [sys.executable, "-B", os.path.abspath(__file__), "--print-desktop"],
                check=True,
                capture_output=True,
                text=True,
            )
            print(nested.stdout.strip(), flush=True)
            return 0
        if sys.argv[1:] == ["--self-test"]:
            return run(
                [sys.executable, "-B", os.path.abspath(__file__), "--spawn-nested-desktop"]
            )
        return run(sys.argv[1:])
    except BaseException as error:
        print(f"mcp-dog-worker private desktop launcher failed: {error}", file=sys.stderr)
        return 127


if __name__ == "__main__":
    sys.exit(main())
