import React from "react";
import ReactDOM from "react-dom/client";

async function boot() {
  const App = (await Promise.all([import("./desk/DeskApp"), import("./desk/desk.css")]))[0].default;
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
