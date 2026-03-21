"use client";

import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { ANIM } from "@/lib/animation";

/**
 * Extract the "page-level" key from a pathname, ignoring sub-routes
 * that render as side panels (e.g. task/idea detail overlays).
 *
 * /projects/[uuid]/tasks/[taskUuid]  → /projects/[uuid]/tasks
 * /projects/[uuid]/ideas/[ideaUuid]  → /projects/[uuid]/ideas
 * /projects/[uuid]/documents/[docUuid] → /projects/[uuid]/documents
 * /projects/[uuid]/proposals/[propUuid] → /projects/[uuid]/proposals
 * /projects/[uuid]/dashboard          → /projects/[uuid]/dashboard
 * /projects                           → /projects
 * /settings                           → /settings
 */
function getPageKey(pathname: string): string {
  // Match /projects/<uuid>/<section>/<detail-uuid> — strip the detail UUID
  const match = pathname.match(
    /^(\/projects\/[a-f0-9-]{36}\/(tasks|ideas|documents|proposals))\/.+$/
  );
  if (match) return match[1];
  return pathname;
}

export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const pageKey = getPageKey(pathname);

  return (
    <motion.div
      key={pageKey}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: ANIM.normal, ease: ANIM.easeOut }}
      className="flex-1 flex flex-col"
    >
      {children}
    </motion.div>
  );
}
