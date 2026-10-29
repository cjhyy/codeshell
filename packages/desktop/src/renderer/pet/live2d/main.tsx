import React from "react";
import { createRoot } from "react-dom/client";
import { MimiCompanionWindow } from "./MimiCompanionWindow";

const root = document.getElementById("root");
if (!root) throw new Error("Companion root is missing.");
createRoot(root).render(<MimiCompanionWindow />);
