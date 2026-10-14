import type { ITheme } from '@xterm/xterm'

export interface TerminalTheme {
  id: string
  name: string
  dark: boolean
  theme: ITheme
}

function t(
  id: string,
  name: string,
  dark: boolean,
  bg: string,
  fg: string,
  cursor: string,
  selection: string,
  ansi: [string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string]
): TerminalTheme {
  const [black, red, green, yellow, blue, magenta, cyan, white, bBlack, bRed, bGreen, bYellow, bBlue, bMagenta, bCyan, bWhite] = ansi
  return {
    id,
    name,
    dark,
    theme: {
      background: bg,
      foreground: fg,
      cursor,
      cursorAccent: bg,
      selectionBackground: selection,
      black,
      red,
      green,
      yellow,
      blue,
      magenta,
      cyan,
      white,
      brightBlack: bBlack,
      brightRed: bRed,
      brightGreen: bGreen,
      brightYellow: bYellow,
      brightBlue: bBlue,
      brightMagenta: bMagenta,
      brightCyan: bCyan,
      brightWhite: bWhite
    }
  }
}

/** Built-in color schemes (palettes from well-known open-source themes). */
export const TERMINAL_THEMES: TerminalTheme[] = [
  t('sshtool-dark', 'SSH Tool Dark', true, '#131520', '#d9dce6', '#5b7fff', '#5b7fff55', [
    '#20232f', '#f05b5b', '#33c47b', '#f0c43a', '#5b7fff', '#b06cff', '#29c3d9', '#c7cad6',
    '#5e6378', '#ff7a7a', '#5ee39b', '#ffd866', '#82a0ff', '#c995ff', '#5fdcec', '#ffffff'
  ]),
  t('sshtool-light', 'SSH Tool Light', false, '#fbfbfd', '#2a2e3d', '#3d68f5', '#3d68f533', [
    '#2a2e3d', '#d23c3c', '#1f9d5c', '#b07a00', '#3d68f5', '#9445d6', '#0e8fa3', '#c9ccd6',
    '#6b7085', '#e85555', '#2fb872', '#c99000', '#5b82ff', '#ac63ea', '#21a9bd', '#ffffff'
  ]),
  t('dracula', 'Dracula', true, '#282a36', '#f8f8f2', '#f8f8f2', '#44475a', [
    '#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
    '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'
  ]),
  t('one-dark', 'One Dark', true, '#282c34', '#abb2bf', '#528bff', '#3e4451', [
    '#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
    '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff'
  ]),
  t('solarized-dark', 'Solarized Dark', true, '#002b36', '#839496', '#93a1a1', '#073642', [
    '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
    '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'
  ]),
  t('solarized-light', 'Solarized Light', false, '#fdf6e3', '#657b83', '#586e75', '#eee8d5', [
    '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
    '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'
  ]),
  t('monokai', 'Monokai', true, '#272822', '#f8f8f2', '#f8f8f0', '#49483e', [
    '#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2',
    '#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5'
  ]),
  t('nord', 'Nord', true, '#2e3440', '#d8dee9', '#d8dee9', '#434c5e', [
    '#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
    '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'
  ]),
  t('gruvbox-dark', 'Gruvbox Dark', true, '#282828', '#ebdbb2', '#ebdbb2', '#504945', [
    '#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984',
    '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'
  ]),
  t('tokyo-night', 'Tokyo Night', true, '#1a1b26', '#c0caf5', '#c0caf5', '#33467c', [
    '#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6',
    '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5'
  ]),
  t('catppuccin-mocha', 'Catppuccin Mocha', true, '#1e1e2e', '#cdd6f4', '#f5e0dc', '#585b70', [
    '#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de',
    '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8'
  ]),
  t('github-dark', 'GitHub Dark', true, '#0d1117', '#c9d1d9', '#58a6ff', '#264f78', [
    '#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4',
    '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc'
  ]),
  t('github-light', 'GitHub Light', false, '#ffffff', '#24292f', '#0969da', '#b6e3ff', [
    '#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781',
    '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f'
  ]),
  t('material', 'Material', true, '#263238', '#eeffff', '#ffcc00', '#546e7a', [
    '#000000', '#e53935', '#91b859', '#ffb62c', '#6182b8', '#7c4dff', '#39adb5', '#ffffff',
    '#546e7a', '#ff5370', '#c3e88d', '#ffcb6b', '#82aaff', '#c792ea', '#89ddff', '#ffffff'
  ]),
  t('night-owl', 'Night Owl', true, '#011627', '#d6deeb', '#80a4c2', '#1d3b53', [
    '#011627', '#ef5350', '#22da6e', '#addb67', '#82aaff', '#c792ea', '#21c7a8', '#ffffff',
    '#575656', '#ef5350', '#22da6e', '#ffeb95', '#82aaff', '#c792ea', '#7fdbca', '#ffffff'
  ]),
  t('ayu-dark', 'Ayu Dark', true, '#0b0e14', '#bfbdb6', '#e6b450', '#273747', [
    '#11151c', '#ea6c73', '#7fd962', '#f9af4f', '#53bdfa', '#cda1fa', '#90e1c6', '#c7c7c7',
    '#686868', '#f07178', '#aad94c', '#ffb454', '#59c2ff', '#d2a6ff', '#95e6cb', '#ffffff'
  ]),
  t('tomorrow-night', 'Tomorrow Night', true, '#1d1f21', '#c5c8c6', '#c5c8c6', '#373b41', [
    '#1d1f21', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#c5c8c6',
    '#969896', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#ffffff'
  ]),
  t('matrix', 'Matrix', true, '#000000', '#00ff41', '#00ff41', '#003b00', [
    '#000000', '#008f11', '#00ff41', '#33ff33', '#00b81c', '#20c20e', '#00d65a', '#99ff99',
    '#0d3d0d', '#00a816', '#33ff66', '#66ff66', '#00e622', '#4dff4d', '#26ff8c', '#ccffcc'
  ])
]

export function getTheme(id: string | undefined, fallbackDark = true): TerminalTheme {
  return TERMINAL_THEMES.find((x) => x.id === id) ?? TERMINAL_THEMES[fallbackDark ? 0 : 1]
}
