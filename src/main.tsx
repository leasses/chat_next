import { installPolyfills } from './polyfills.js'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './app/global.css'
import './app/motion.css'

// 必须在任何应用代码之前补齐内建方法，否则旧 WebView 会在调用处直接抛错
installPolyfills()

ensureKatex()
setupTheme()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)