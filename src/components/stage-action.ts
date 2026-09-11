import type { ReactNode } from "react";

/** Optional presentation adapter. The owner (and its dialogs) stays mounted
 * outside the rendered trigger's lifecycle, including portalled menus. */
export interface StageAction {
  label: string;
  disabledReason?: string;
  busy: boolean;
  onSelect: () => void;
}

export interface StageActionPresentation {
  renderAction?: (action: StageAction) => ReactNode;
  disabledReason?: string;
  onCloseAutoFocus?: (event: Event) => void;
}
