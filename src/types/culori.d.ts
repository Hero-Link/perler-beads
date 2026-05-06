declare module 'culori' {
  export function differenceCiede2000(
    Kl?: number,
    Kc?: number,
    Kh?: number
  ): (color1: string | object, color2: string | object) => number;
}
