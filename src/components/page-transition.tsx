"use client";

import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { fadeInUp } from "@/lib/animation";

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
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={pageKey}
        variants={fadeInUp}
        initial="initial"
        animate="animate"
        exit="exit"
        className="flex-1"
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
