/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import DeleteDataDialog, { type DataTarget } from "./delete-data-dialog";

/**
 * **Delete data…** on an entry under Not in this build. Destructive, and the
 * dialog it opens says what goes and asks for the name typed before anything
 * is deleted. Keeping the data needs nothing.
 */
export default function DeleteDataButton(target: DataTarget) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        Delete data…<span className="sr-only"> ({target.name})</span>
      </Button>
      {open && <DeleteDataDialog target={target} onClose={() => setOpen(false)} />}
    </>
  );
}
