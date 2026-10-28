"""Bug condition exploration test for the shai CLI subcommand fix.

Spec: .kiro/specs/shai-cli-subcommand-fix

Property 1 (Bug Condition / Expected Behavior) - shai headless invocation.

The OVH `shai` CLI dropped the `chat` subcommand in version 0.2.2 and now uses
headless mode `shai -p "<prompt>"`. The agentic-AI integration in
`src/routes/genai_routes.py` still builds `shai chat --trust-all-tools "<prompt>"`
at two call sites, both gated by `elif agentic_engine.lower() == 'shai':`
(operator START/STOP run path, ~line 357; request-dev-AI / MODIFY_CODE path,
~line 591), so every shai run fails with `error: unrecognized subcommand 'chat'`.

This test encodes the EXPECTED behavior from Property 1: at each shai call site
the built command SHALL equal `[engine_cmd, '-p', l_prompt]` and contain neither
`'chat'` nor `'--trust-all-tools'`, with argv[0] being the resolved `engine_cmd`
from `get_shai_paths()` rather than the literal `agentic_engine` string.

CRITICAL: On the UNFIXED code this test MUST FAIL. The failure surfaces the
counterexample `['shai', 'chat', '--trust-all-tools', prompt]` that proves the
bug exists. After the fix is applied (later task), this same test passes and
validates the fix.

The command construction is embedded in a long streaming generator with
subprocess/environment/binary dependencies that cannot be exercised end-to-end
in the harness, so (per the design's lightweight verification strategy) this
test statically extracts the exact shai-branch `cmd_args` assignments from the
source and asserts their shape against Property 1.

Validates: Requirements 1.1, 1.2, 2.1, 2.2
"""

import ast
import os

import pytest

ROUTES_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "src",
    "routes",
    "genai_routes.py",
)


def _shai_branch_cmd_args():
    """Return the list of `cmd_args = [...]` elements found inside each
    `elif agentic_engine.lower() == 'shai':` branch in genai_routes.py.

    Each returned item is a list of the literal/name tokens that make up the
    cmd_args list at a shai call site, e.g.
        ['agentic_engine', 'chat', '--trust-all-tools', 'l_prompt']   (unfixed)
    or
        ['engine_cmd', '-p', 'l_prompt']                              (fixed)

    String literals are returned as their value; names (e.g. engine_cmd,
    agentic_engine, l_prompt) are returned as the identifier string.
    """
    with open(ROUTES_PATH, "r", encoding="utf-8") as fh:
        source = fh.read()
    tree = ast.parse(source)

    def elements(list_node):
        out = []
        for el in list_node.elts:
            if isinstance(el, ast.Constant):
                out.append(el.value)
            elif isinstance(el, ast.Name):
                out.append(el.id)
            else:
                # Any other expression (call, fstring, etc.) - keep a marker.
                out.append(ast.dump(el))
        return out

    def is_shai_test(test):
        # Match: agentic_engine.lower() == 'shai'
        if not isinstance(test, ast.Compare):
            return False
        left = test.left
        if not (
            isinstance(left, ast.Call)
            and isinstance(left.func, ast.Attribute)
            and left.func.attr == "lower"
            and isinstance(left.func.value, ast.Name)
            and left.func.value.id == "agentic_engine"
        ):
            return False
        return any(
            isinstance(c, ast.Constant) and c.value == "shai"
            for c in test.comparators
        )

    def find_cmd_args_in_body(body):
        found = []
        for stmt in body:
            if isinstance(stmt, ast.Assign):
                targets = [t for t in stmt.targets if isinstance(t, ast.Name)]
                if any(t.id == "cmd_args" for t in targets) and isinstance(
                    stmt.value, ast.List
                ):
                    found.append(elements(stmt.value))
        return found

    results = []
    for node in ast.walk(tree):
        if isinstance(node, ast.If) and is_shai_test(node.test):
            results.extend(find_cmd_args_in_body(node.body))
    return results


def test_shai_branches_exist():
    """Sanity: there are exactly two shai call sites building cmd_args."""
    cmds = _shai_branch_cmd_args()
    assert len(cmds) == 2, (
        "Expected exactly two shai-branch cmd_args assignments "
        f"(operator START/STOP ~line 357 and MODIFY_CODE ~line 591), found {len(cmds)}: {cmds}"
    )


@pytest.mark.parametrize("site", [0, 1], ids=["operator_start_stop", "request_dev_ai_modify_code"])
def test_shai_headless_command_property(site):
    """Property 1: each shai site SHALL build [engine_cmd, '-p', l_prompt] with
    neither 'chat' nor '--trust-all-tools'.

    On UNFIXED code this FAILS because the site builds
    ['agentic_engine', 'chat', '--trust-all-tools', 'l_prompt'] -> the
    counterexample that proves the bug.
    """
    cmds = _shai_branch_cmd_args()
    assert len(cmds) == 2, f"Expected two shai call sites, found {len(cmds)}"
    cmd = cmds[site]

    # Expected headless form from Property 1.
    assert cmd == ["engine_cmd", "-p", "l_prompt"], (
        f"shai site {site} builds {cmd!r}; "
        "Property 1 requires [engine_cmd, '-p', l_prompt] "
        "(shai 0.2.2 headless mode, argv[0] = resolved engine_cmd)"
    )
    # Property 1 absence assertions.
    assert "chat" not in cmd, (
        f"shai site {site} still carries the removed 'chat' subcommand: {cmd!r} "
        "-> shai 0.2.2 rejects it with: error: unrecognized subcommand 'chat'"
    )
    assert "--trust-all-tools" not in cmd, (
        f"shai site {site} still carries the no-longer-applicable "
        f"'--trust-all-tools' flag: {cmd!r}"
    )
    # argv[0] must be the resolved executable, not the literal engine name.
    assert cmd[0] == "engine_cmd", (
        f"shai site {site} uses argv[0]={cmd[0]!r}; it must be the resolved "
        "engine_cmd from get_shai_paths() (as reported in the 'Found ... at' "
        "message), not the literal agentic_engine string"
    )
