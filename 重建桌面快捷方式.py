# -*- coding: utf-8 -*-
"""用纯 ctypes 调用 IShellLinkW 创建 .lnk 快捷方式（不依赖 powershell/cscript/COM 自动化）"""
import ctypes
import os
from ctypes import wintypes, c_wchar_p, POINTER, byref, c_int

ole32 = ctypes.WinDLL('ole32', use_last_error=True)
ole32.CoInitialize(None)

CLSID_ShellLink = '{00021401-0000-0000-C000-000000000046}'
IID_IShellLinkW = '{000214F9-0000-0000-C000-000000000046}'
IID_IPersistFile = '{0000010b-0000-0000-C000-000000000046}'


class GUID(ctypes.Structure):
    _fields_ = [('Data1', ctypes.c_ulong), ('Data2', ctypes.c_ushort),
                ('Data3', ctypes.c_ushort), ('Data4', ctypes.c_ubyte * 8)]

    def __init__(self, s):
        ole32.IIDFromString(s, byref(self))


SLR_OK = 0
SW_NORMAL = 1

'''
IShellLinkW vtable:
0 QueryInterface 1 AddRef 2 Release
3 GetPath 4 GetIDList 5 SetIDList
6 GetDescription 7 SetDescription
8 GetWorkingDirectory 9 SetWorkingDirectory
10 GetArguments 11 SetArguments
12 GetHotkey 13 SetHotkey
14 GetShowCmd 15 SetShowCmd
16 GetIconLocation 17 SetIconLocation
18 SetRelativePath 19 Resolve 20 SetPath
'''


def make_shortcut(lnk_path, target, workdir, icon_loc, desc):
    psl = POINTER(ctypes.c_void_p)()
    hr = ole32.CoCreateInstance(byref(GUID(CLSID_ShellLink)), None, 1,
                                byref(GUID(IID_IShellLinkW)), byref(psl))
    if hr != 0:
        raise OSError('CoCreateInstance failed 0x%08X' % (hr & 0xFFFFFFFF))
    vt = ctypes.cast(psl, POINTER(POINTER(ctypes.c_void_p))).contents

    SetPath = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, c_wchar_p)(vt[20])
    SetWorkingDirectory = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, c_wchar_p)(vt[9])
    SetDescription = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, c_wchar_p)(vt[7])
    SetIconLocation = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, c_wchar_p, c_int)(vt[17])
    SetShowCmd = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, c_int)(vt[15])

    for name, fn, args in (
        ('SetPath', SetPath, (target,)),
        ('SetWorkingDirectory', SetWorkingDirectory, (workdir,)),
        ('SetDescription', SetDescription, (desc,)),
    ):
        r = fn(psl, *args)
        if r != 0:
            print('warn %s -> 0x%08X' % (name, r & 0xFFFFFFFF))

    r = SetIconLocation(psl, icon_loc, 0)
    if r != 0:
        print('warn SetIconLocation -> 0x%08X' % (r & 0xFFFFFFFF))
    SetShowCmd(psl, SW_NORMAL)

    ppf = ctypes.c_void_p()
    QueryInterface = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p,
                                        POINTER(GUID), POINTER(ctypes.c_void_p))(vt[0])
    hr = QueryInterface(psl, byref(GUID(IID_IPersistFile)), byref(ppf))
    if hr != 0:
        raise OSError('QueryInterface IPersistFile failed 0x%08X' % (hr & 0xFFFFFFFF))
    pfv = ctypes.cast(ppf, POINTER(POINTER(ctypes.c_void_p))).contents
    Save = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, c_wchar_p, ctypes.c_bool)(pfv[6])
    Save2 = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, c_wchar_p, ctypes.c_bool)(pfv[6])
    r = Save(ppf, lnk_path, True)
    if r != 0:
        raise OSError('Save failed 0x%08X' % (r & 0xFFFFFFFF))
    print('created:', lnk_path)


if __name__ == '__main__':
    # 用脚本自己所在的目录当基准：整个文件夹拷到哪儿都能用，不用改路径
    base = os.path.dirname(os.path.abspath(__file__))
    desktop = os.path.join(os.path.expanduser('~'), 'Desktop')
    make_shortcut(
        lnk_path=os.path.join(desktop, '侧边备忘录.lnk'),
        target=os.path.join(base, '启动备忘录.vbs'),
        workdir=base,
        icon_loc=os.path.join(base, 'node_modules', 'electron', 'dist', 'electron.exe') + ',0',
        desc='侧边备忘录 - 贴边桌面备忘工具',
    )
    ole32.CoUninitialize()
