import packJson from "../../assets/mimi-papillon/performer-pack.json";
import { parseCharacterPack } from "./character-pack";

/** Mimi's performer moves. To swap the character, replace the atlas and this
 * manifest together (see the character pack guideline). */
export const BUNDLED_PACK = parseCharacterPack(packJson);
