import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
// React Flow's structural styles only (positioning, pointer events); the look is the app's own.
import "@xyflow/react/dist/base.css"
import "./styles/app.css"

createRoot(document.getElementById("root")!).render(<App />)
