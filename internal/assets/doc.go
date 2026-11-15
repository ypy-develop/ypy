// SPDX-License-Identifier: MIT

// Package assets implements "ypy gen assets": it takes the CSS and the small
// scripts an author writes next to a template and extracts them into files
// whose names carry a hash of their content, so the page that results has
// nothing inline and passes a strict Content-Security-Policy.
//
// # Where the author writes
//
// In a template (.html, .gohtml, .templ or .kyse.go) a <style ypy-asset> or a
// <script ypy-asset> element is an asset of that template. Next to a template
// a file name.ypy.css or name.ypy.js is the same thing without the markup.
//
// # Grouping
//
// The default is one stylesheet and one script per package, a package being a
// directory. A component library is written and shipped by directory, a page
// asks for the pieces it uses with one name each, and a change in one template
// invalidates the cache of its neighbours only. The alternative, one pair per
// template, is --group template; it suits a site whose pages share almost
// nothing.
//
// # Output
//
// <name>.<hash>.css and <name>.<hash>.js, where hash is the first HashLen hex
// digits of the SHA-256 of the file, and manifest.json:
//
//	{"ui/cards": {"css": "ui-cards.1a2b3c4d5e.css", "js": "ui-cards.9f8e7d6c5b.js"}}
//
// The paths in the manifest are relative to its directory. Nothing in the
// output depends on the time, the machine or the order of a directory listing,
// so a run on the same input writes the same bytes, and --check can compare.
//
// The Go SDK reads the manifest (ypy.LoadManifest) and writes the <link> and
// <script> tags with integrity and the nonce of the page.
package assets
