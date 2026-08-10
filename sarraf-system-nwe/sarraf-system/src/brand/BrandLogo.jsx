import React from "react";
import { BRAND } from "./brand";

export function BrandLogo({ variant = "symbol", theme = "light", decorative = false, className = "", label }) {
  const src = variant === "symbol"
    ? BRAND.assets.symbol
    : theme === "dark" ? BRAND.assets.horizontalDark : BRAND.assets.horizontalLight;
  return <img src={src} className={className} width={variant === "symbol" ? 48 : 208}
    height={48} alt={decorative ? "" : (label || BRAND.logoLabel.en)} aria-hidden={decorative || undefined} />;
}
