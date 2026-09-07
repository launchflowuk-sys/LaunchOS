-- A lead that has been spoken to and is worth quoting for.
--
-- new → contacted → qualified → converted | lost. The step existed in how the
-- work is actually done — Shoji rings them, decides they are real, then writes
-- a proposal — but had nowhere to be recorded, so a qualified lead and one
-- nobody had assessed yet looked identical on the board.
--
-- BEFORE 'converted' keeps the enum in the order the pipeline runs, so the
-- filter tabs and any ORDER BY read the way the work does.
ALTER TYPE "public"."lead_status" ADD VALUE 'qualified' BEFORE 'converted';