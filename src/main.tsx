import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App.tsx'

if (import.meta.env.DEV) {
  import('./dev-mock').then(({ installDevMock }) => installDevMock())
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
