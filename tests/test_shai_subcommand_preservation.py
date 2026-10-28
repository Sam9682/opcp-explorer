"""Preservation property test for the shai CLI subcommand fix.

Spec: .kiro/specs/shai-cli-subcommand-fix

Property 2 (Preservation) - non-shai paths and engine resolution unchanged.

Observation-first methodology: this test is written and run BEFORE the fix. It
captures the BASELINE behavior of every execution path that does NOT satisfy the
bug condition, so the same assertions can be re-run after the fix (task 3.3) to
prove nothing outside the two shai `cmd_args` lines changed.

For any input where `isBugCondition` is false, the fixed code must behave exactly
like the original (design, Property 2 / Preservation Requirements):

  - Req 3.1: the qchat / Kiro-cli `else` branch still builds
    `[engine_cmd, 'chat', '--trust-all-tools', l_prompt]` (two occurrences,
    ~line 368 and ~line 602).
  - Req 3.2: a provided `agentic_command` still runs `deployControlPlan.sh`
    with that command (two occurrences, ~line 341 and ~line 575).
  - Req 3.3: engine `shai` with empty `get_shai_paths()` still yields the
    engine-not-found error and `return`s before any `subprocess.Popen` call
    (two occurrences).

Per the design's lightweight verification strategy, the command construction is
embedded in a long streaming generator with subprocess / environment / binary
dependencies that cannot be exercised end-to-end in the harness. So this test
statically extracts the relevant branches from the source via AST (mirroring
`test_shai_subcommand_bug_condition.py`) and asserts the preserved shapes.

EXPECTED OUTCOME on UNFIXED code: PASS. These assertions describe branches the
fix must NOT touch, so they must hold both before and after the fix.

Validates: Requirements 3.1, 3.2, 3.3
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


def _load_tree():
    with open(ROUTES_PATH, "r", encoding="utf-8") as fh:
        source = fh.read()
    return ast.parse(source)


def _list_elements(list_node):
    """Return literal/name tokens of an ast.List: constants as their value,
    names as their identifier string, everything else as a dump marker."""
    out = []
    for el in list_node.elts:
        if isinstance(el, ast.Constant):
            out.append(el.value)
        elif isinstance(el, ast.Name):
            out.append(el.id)
        else:
            out.append(ast.dump(el))
    return out


def _cmd_args_assignments_in_body(body):
    """Return the token lists of every `cmd_args = [...]` assignment that is a
    DIRECT statement of the given branch body (not nested deeper)."""
    found = []
    for stmt in body:
        if isinstance(stmt, ast.Assign):
            targets = [t for t in stmt.targets if isinstance(t, ast.Name)]
            if any(t.id == "cmd_args" for t in targets) and isinstance(
                stmt.value, ast.List
            ):
                found.append(_list_elements(stmt.value))
    return found


def _is_agentic_command_test(test):
    """Match: `if agentic_command:` (a bare Name truthiness test)."""
    return isinstance(test, ast.Name) and test.id == "agentic_command"


def _is_shai_test(test):
    """Match: `agentic_engine.lower() == 'shai'`."""
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


def _dispatch_if_nodes():
    """Return the top `if agentic_command:` If nodes that dispatch the engine
    selection (there is one per call site: operator START/STOP and
    request-dev-AI / MODIFY_CODE)."""
    tree = _load_tree()
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.If) and _is_agentic_command_test(node.test)
    ]


def _qchat_else_cmd_args():
    """Return the token lists from each qchat `else:` branch.

    The dispatch chain is `if agentic_command: ... elif shai: ... else: qchat`.
    In the AST that is an If(test=agentic_command) whose orelse contains a
    single If(test=shai) whose own orelse is the qchat else-body.
    """
    results = []
    for node in _dispatch_if_nodes():
        orelse = node.orelse
        # The elif collapses to a nested If in `orelse`.
        if len(orelse) == 1 and isinstance(orelse[0], ast.If) and _is_shai_test(
            orelse[0].test
        ):
            qchat_body = orelse[0].orelse
            results.extend(_cmd_args_assignments_in_body(qchat_body))
    return results


def _agentic_command_cmd_args():
    """Return the token lists from each `if agentic_command:` branch body."""
    results = []
    for node in _dispatch_if_nodes():
        results.extend(_cmd_args_assignments_in_body(node.body))
    return results


def _shai_branch_nodes():
    """Return the shai `elif` If nodes (one per call site)."""
    results = []
    for node in _dispatch_if_nodes():
        orelse = node.orelse
        if len(orelse) == 1 and isinstance(orelse[0], ast.If) and _is_shai_test(
            orelse[0].test
        ):
            results.append(orelse[0])
    return results


# --- Req 3.1: qchat / Kiro-cli else branch preserved ------------------------


def test_two_qchat_else_branches_exist():
    """Sanity: there is one qchat `else` branch per call site (two total)."""
    cmds = _qchat_else_cmd_args()
    assert len(cmds) == 2, (
        "Expected exactly two qchat else-branch cmd_args assignments "
        f"(~line 368 and ~line 602), found {len(cmds)}: {cmds}"
    )


@pytest.mark.parametrize(
    "site", [0, 1], ids=["operator_start_stop", "request_dev_ai_modify_code"]
)
def test_qchat_else_branch_preserved(site):
    """Req 3.1: the qchat `else` branch builds
    [engine_cmd, 'chat', '--trust-all-tools', l_prompt] unchanged."""
    cmds = _qchat_else_cmd_args()
    assert len(cmds) == 2, f"Expected two qchat else branches, found {len(cmds)}"
    cmd = cmds[site]
    assert cmd == ["engine_cmd", "chat", "--trust-all-tools", "l_prompt"], (
        f"qchat else branch {site} builds {cmd!r}; Req 3.1 requires it to stay "
        "[engine_cmd, 'chat', '--trust-all-tools', l_prompt] (must NOT be "
        "touched by the shai fix)"
    )


# --- Req 3.2: agentic_command / deployControlPlan.sh branch preserved -------


def test_two_agentic_command_branches_exist():
    """Sanity: one agentic_command branch per call site (two total)."""
    cmds = _agentic_command_cmd_args()
    assert len(cmds) == 2, (
        "Expected exactly two agentic_command cmd_args assignments "
        f"(~line 341 and ~line 575), found {len(cmds)}: {cmds}"
    )


@pytest.mark.parametrize(
    "site", [0, 1], ids=["operator_start_stop", "request_dev_ai_modify_code"]
)
def test_agentic_command_branch_preserved(site):
    """Req 3.2: a provided agentic_command runs deployControlPlan.sh with that
    command. argv[0] is the deployControlPlan.sh path (an f-string) and argv[1]
    is the agentic_command name."""
    cmds = _agentic_command_cmd_args()
    assert len(cmds) == 2, f"Expected two agentic_command branches, found {len(cmds)}"
    cmd = cmds[site]
    assert len(cmd) == 2, (
        f"agentic_command branch {site} builds {cmd!r}; Req 3.2 requires exactly "
        "[<deployControlPlan.sh path>, agentic_command]"
    )
    # argv[0] is an f-string ending in deployControlPlan.sh (kept as an AST dump
    # marker by _list_elements); assert it references deployControlPlan.sh.
    assert "deployControlPlan.sh" in cmd[0], (
        f"agentic_command branch {site} argv[0]={cmd[0]!r} must reference "
        "deployControlPlan.sh (Req 3.2)"
    )
    assert cmd[1] == "agentic_command", (
        f"agentic_command branch {site} argv[1]={cmd[1]!r} must be the "
        "agentic_command (Req 3.2)"
    )


# --- Req 3.3: shai-not-found early return preserved -------------------------


def test_two_shai_branches_exist():
    """Sanity: one shai elif branch per call site (two total)."""
    nodes = _shai_branch_nodes()
    assert len(nodes) == 2, (
        f"Expected exactly two shai elif branches, found {len(nodes)}"
    )


@pytest.mark.parametrize(
    "site", [0, 1], ids=["operator_start_stop", "request_dev_ai_modify_code"]
)
def test_shai_not_found_early_return_preserved(site):
    """Req 3.3: when get_shai_paths() resolves nothing the shai branch yields an
    engine-not-found error and returns BEFORE building cmd_args / launching a
    process.

    Structurally: the shai branch contains an `if not engine_cmd:` whose body
    is a yield followed by a bare `return`, and that guard appears before the
    `cmd_args = ...` assignment in the branch body.
    """
    nodes = _shai_branch_nodes()
    assert len(nodes) == 2, f"Expected two shai branches, found {len(nodes)}"
    body = nodes[site].body

    guard_index = None
    cmd_args_index = None
    for i, stmt in enumerate(body):
        if (
            isinstance(stmt, ast.If)
            and isinstance(stmt.test, ast.UnaryOp)
            and isinstance(stmt.test.op, ast.Not)
            and isinstance(stmt.test.operand, ast.Name)
            and stmt.test.operand.id == "engine_cmd"
        ):
            guard_index = i
            # The guard body must early-return.
            has_return = any(isinstance(s, ast.Return) for s in stmt.body)
            has_yield = any(
                isinstance(s, ast.Expr) and isinstance(s.value, ast.Yield)
                for s in stmt.body
            )
            assert has_return, (
                f"shai branch {site}: `if not engine_cmd:` guard must early "
                "`return` (Req 3.3)"
            )
            assert has_yield, (
                f"shai branch {site}: `if not engine_cmd:` guard must yield the "
                "engine-not-found error before returning (Req 3.3)"
            )
        if (
            isinstance(stmt, ast.Assign)
            and any(
                isinstance(t, ast.Name) and t.id == "cmd_args"
                for t in stmt.targets
            )
        ):
            cmd_args_index = i

    assert guard_index is not None, (
        f"shai branch {site}: missing `if not engine_cmd:` not-found guard "
        "(Req 3.3)"
    )
    assert cmd_args_index is not None, (
        f"shai branch {site}: missing cmd_args assignment"
    )
    assert guard_index < cmd_args_index, (
        f"shai branch {site}: the not-found early return (index {guard_index}) "
        f"must precede the cmd_args assignment (index {cmd_args_index}) so no "
        "process is launched when shai is unresolved (Req 3.3)"
    )


# --- Baseline count: the whole chat/--trust-all-tools surface ---------------


def test_baseline_chat_trust_all_tools_occurrence_count():
    """Baseline observation on UNFIXED code: there are four
    `'chat', '--trust-all-tools'` cmd_args lines total - two shai sites (to be
    fixed) and two qchat sites (to be preserved).

    After the fix (task 3.3) exactly the two qchat occurrences remain. Capturing
    the baseline here documents the starting point for that comparison.
    """
    with open(ROUTES_PATH, "r", encoding="utf-8") as fh:
        source = fh.read()
    occurrences = source.count("'chat', '--trust-all-tools'")
    assert occurrences == 4, (
        "Baseline (unfixed) expects four \"'chat', '--trust-all-tools'\" "
        f"occurrences (2 shai + 2 qchat), found {occurrences}. After the fix "
        "only the 2 qchat occurrences should remain."
    )
