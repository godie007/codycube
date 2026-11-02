import { createRoot } from 'react-dom/client'
import { App } from './App'
import { UiProvider } from './components/ui'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <UiProvider>
    <App />
  </UiProvider>
)
