"use client"

import * as React from "react"
import { User } from "lucide-react"
import { useTranslations } from "next-intl"
import { Style, Avatar as DiceBearAvatar, type StyleDefinition } from "@dicebear/core"
import personasDefinition from "@dicebear/styles/personas.json"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"

let personasStyle: Style | undefined

export function getUserAvatarDataUri(avatarSeed?: string | null): string | null {
  if (!avatarSeed?.trim()) return null

  try {
    personasStyle ??= new Style(personasDefinition as unknown as StyleDefinition)
    return new DiceBearAvatar(personasStyle, {
      seed: avatarSeed,
      tags: ["!animation"],
    }).toDataUri()
  } catch {
    return null
  }
}

const SIZE_PX = { xs: 20, sm: 24, md: 32, lg: 40 } as const

export type UserAvatarSize = keyof typeof SIZE_PX | number

export interface UserAvatarProps {
  userUuid?: string | null
  name?: string | null
  avatarSeed?: string | null
  size?: UserAvatarSize
  className?: string
  decorative?: boolean
  "aria-label"?: string
  "aria-hidden"?: boolean
}

export function UserAvatar({
  userUuid,
  name,
  avatarSeed,
  size = "md",
  className,
  decorative = false,
  "aria-label": ariaLabel,
  "aria-hidden": ariaHidden,
}: UserAvatarProps) {
  const translate = useTranslations("common")
  const dataUri = React.useMemo(() => getUserAvatarDataUri(avatarSeed), [avatarSeed])
  const requestedPx = typeof size === "number" ? size : SIZE_PX[size]
  const px = Number.isFinite(requestedPx) && requestedPx > 0 ? requestedPx : SIZE_PX.md
  const initial = Array.from(name?.trim() ?? "")[0]?.toUpperCase()
  const hidden = decorative || ariaHidden === true

  return (
    <Avatar
      data-slot="user-avatar"
      data-user-uuid={userUuid ?? undefined}
      data-motion="static"
      role={hidden ? undefined : "img"}
      aria-label={hidden ? undefined : ariaLabel?.trim() || name?.trim() || translate("user")}
      aria-hidden={hidden ? true : undefined}
      className={cn("shrink-0 bg-muted text-muted-foreground", className)}
      style={{ width: px, height: px }}
    >
      {dataUri ? (
        <AvatarImage key={dataUri} src={dataUri} alt="" aria-hidden draggable={false} />
      ) : null}
      <AvatarFallback aria-hidden>
        {initial ? (
          <span className="font-medium" style={{ fontSize: px * 0.4 }}>{initial}</span>
        ) : (
          <User className="size-1/2" aria-hidden />
        )}
      </AvatarFallback>
    </Avatar>
  )
}

export default UserAvatar
