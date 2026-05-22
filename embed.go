// Wirgloo — a self-hosted web IRC client.
// https://github.com/cstroie/wirgloo
//
// Copyright (C) 2025 Costin Stroie <costinstroie@eridu.eu.org>
// SPDX-License-Identifier: GPL-3.0-or-later
package wirgloo

import "embed"

//go:embed static/*
var StaticFiles embed.FS // embedded copy of the static/ directory, baked in at compile time
