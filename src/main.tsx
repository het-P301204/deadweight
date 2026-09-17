import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App.tsx'
import './index.css'

const host = document.getElementById('root')
if (host === null) throw new Error('DEADWEIGHT: no #root element to mount into.')

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
