import { catalogEntryOrigins, getMergedCatalog } from "@cjhyy/code-shell-core/internal";
import { businessRead, noBusinessArguments } from "./business-read.js";

export const configurationReads = [
  businessRead("models/catalog", noBusinessArguments, getMergedCatalog),
  businessRead("models/catalogOrigins", noBusinessArguments, catalogEntryOrigins),
];
