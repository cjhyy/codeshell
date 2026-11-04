import mimiAtlas from "../../assets/mimi-papillon/spritesheet-v2.webp";
import mimiPerformerAtlas from "../../assets/mimi-papillon/performer-v1.webp";
import shiroAtlas from "../../assets/shiro/spritesheet-v2.webp";
import shiroPosesJson from "../../assets/shiro/poses.json";
import shiroStand from "../../assets/shiro/poses/stand.webp";
import shiroLook from "../../assets/shiro/poses/look.webp";
import shiroPoint from "../../assets/shiro/poses/point.webp";
import shiroKick from "../../assets/shiro/poses/kick.webp";
import shiroStomp from "../../assets/shiro/poses/stomp.webp";
import shiroDash from "../../assets/shiro/poses/dash.webp";
import shiroSitLedge from "../../assets/shiro/poses/sit-ledge.webp";
import shiroLieLedge from "../../assets/shiro/poses/lie-ledge.webp";
import shiroCheer from "../../assets/shiro/poses/cheer.webp";
import shiroFail from "../../assets/shiro/poses/fail.webp";
import makiAtlas from "../../assets/maki/spritesheet-v2.webp";
import makiPosesJson from "../../assets/maki/poses.json";
import makiStand from "../../assets/maki/poses/stand.webp";
import makiLook from "../../assets/maki/poses/look.webp";
import makiPoint from "../../assets/maki/poses/point.webp";
import makiKick from "../../assets/maki/poses/kick.webp";
import makiStomp from "../../assets/maki/poses/stomp.webp";
import makiDash from "../../assets/maki/poses/dash.webp";
import makiSitLedge from "../../assets/maki/poses/sit-ledge.webp";
import makiLieLedge from "../../assets/maki/poses/lie-ledge.webp";
import makiCheer from "../../assets/maki/poses/cheer.webp";
import makiFail from "../../assets/maki/poses/fail.webp";
import makiTwirl from "../../assets/maki/poses/twirl.webp";
import makiPiano from "../../assets/maki/poses/piano.webp";
import makiTomato from "../../assets/maki/poses/tomato.webp";
import makiShy from "../../assets/maki/poses/shy.webp";
import makiWink from "../../assets/maki/poses/wink.webp";
import makiPout from "../../assets/maki/poses/pout.webp";
import type { MimiAppearance } from "../../../shared/mimi-companion";
import { BUNDLED_PACK } from "./bundled-pack";
import type { CharacterPack } from "./character-pack";
import { parsePoseLibrary, type PoseLibrary } from "./pose-library";

/**
 * A sprite character: one 8x11 base atlas (the hatch-pet layout), an optional
 * performer pack and an optional key-pose library. Every character uses the same rows, stage model and
 * move names; a character without a pack plays its base rows everywhere.
 */
export interface SpriteCharacter {
  name: string;
  atlas: string;
  performer?: { atlas: string; pack: CharacterPack };
  /** Large key poses, preferred over the atlas wherever one fits. */
  poses?: { library: PoseLibrary; urls: Partial<Record<string, string>> };
}

export const SPRITE_CHARACTERS = {
  "mimi-sprite": {
    name: "Mimi",
    atlas: mimiAtlas,
    performer: { atlas: mimiPerformerAtlas, pack: BUNDLED_PACK },
  },
  "shiro-sprite": {
    name: "Shiro",
    atlas: shiroAtlas,
    poses: {
      library: parsePoseLibrary(shiroPosesJson),
      urls: {
        stand: shiroStand,
        look: shiroLook,
        point: shiroPoint,
        kick: shiroKick,
        stomp: shiroStomp,
        dash: shiroDash,
        "sit-ledge": shiroSitLedge,
        "lie-ledge": shiroLieLedge,
        cheer: shiroCheer,
        fail: shiroFail,
      },
    },
  },
  "maki-sprite": {
    name: "Maki",
    atlas: makiAtlas,
    poses: {
      library: parsePoseLibrary(makiPosesJson),
      urls: {
        stand: makiStand,
        look: makiLook,
        point: makiPoint,
        kick: makiKick,
        stomp: makiStomp,
        dash: makiDash,
        "sit-ledge": makiSitLedge,
        "lie-ledge": makiLieLedge,
        cheer: makiCheer,
        fail: makiFail,
        twirl: makiTwirl,
        piano: makiPiano,
        tomato: makiTomato,
        shy: makiShy,
        wink: makiWink,
        pout: makiPout,
      },
    },
  },
} satisfies Partial<Record<MimiAppearance, SpriteCharacter>>;

export function spriteCharacter(appearance: MimiAppearance): SpriteCharacter {
  const characters: Partial<Record<MimiAppearance, SpriteCharacter>> = SPRITE_CHARACTERS;
  return characters[appearance] ?? SPRITE_CHARACTERS["mimi-sprite"];
}
