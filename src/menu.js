import { Menu, dialog } from 'electron'

export function installApplicationMenu({ runtime, window, getVersion, onCheckForUpdates, onRollback }) {
  const updateItems = [
    { label: '检查 Harness 更新…', click: onCheckForUpdates },
    { label: '回退上一个 Harness 版本…', click: onRollback },
    {
      label: '当前 Harness 版本',
      click: async () => {
        const version = await getVersion()
        await dialog.showMessageBox(window(), {
          type: 'info',
          title: 'Harness Runtime',
          message: version === undefined ? '尚未安装 Harness Runtime' : `当前版本：${version}`,
        })
      },
    },
  ]
  const applicationMenu = process.platform === 'darwin'
    ? {
        label: 'DeepSeek Harness Desktop',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          ...updateItems,
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }
    : {
        label: '应用',
        submenu: [
          ...updateItems,
          { type: 'separator' },
          { role: 'quit', label: '退出' },
        ],
      }
  const template = [
    applicationMenu,
    { role: 'editMenu' },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'front' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  return runtime
}
