"use client";

import { useState } from "react";
import { Bell } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useNotification } from "@/contexts/notification-context";
import { NotificationPopup } from "@/components/notification-popup";

export function NotificationBell() {
  const { unreadCount } = useNotification();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-8 w-8 text-muted-foreground hover:text-foreground"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#C67A52] px-1 text-[10px] font-medium text-white animate-[pulse-badge_1.5s_ease-in-out_infinite]">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-auto p-0 rounded-lg"
      >
        <NotificationPopup onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
