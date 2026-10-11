import type { Component, Connector, Controller, Describe, Design, Engine, Fault, Telemetry } from "#simulator"

/**
 * The shapes the UI works with, named plainly. Everything here is plain data (durations are milliseconds,
 * faults are JSON): the UI never needs Effect to read it.
 */
export type { Diagnostic } from "#simulator"

export type Doc = Design.Doc
export type NodeDoc = Design.NodeDoc
export type EdgeDoc = Design.EdgeDoc
export type Position = Design.Position

export type ComponentManifest = Component.Manifest
export type ConnectorManifest = Connector.Manifest
export type ControllerManifest = Controller.Manifest
export type Highlight = Component.Highlight

export type FieldSpec = Describe.FieldSpec
export type NumberField = Describe.NumberField
export type ChoiceField = Describe.ChoiceField

export type Stats = Telemetry.Stats
export type Frame = Telemetry.Frame

export type Command = Engine.Command
export type Event = Engine.Event
export type Status = Engine.Status
export type Catalog = Engine.Catalog

export type FaultKind = Fault.FaultKind
export type Target = Fault.Target
export type ActiveFault = Extract<Engine.Event, { readonly _tag: "faults" }>["faults"][number]
