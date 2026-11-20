"""Admin rights helpers.

A user has admin rights when either:
  * their username is ``admin`` (the built-in super admin), or
  * ``users.account_type`` is ``ADMIN`` (granted by the super admin from the
    dashboard "ADMIN" button).

Only the built-in ``admin`` user may grant or revoke admin rights.
"""

SUPER_ADMIN_USERNAME = 'admin'
ADMIN_ACCOUNT_TYPE = 'ADMIN'

# Returns 'admin' for any user holding admin rights, otherwise the username.
# Existing checks of the form ``user[0] == 'admin'`` keep working unchanged.
ADMIN_CHECK_QUERY = (
    "SELECT CASE WHEN username = 'admin' OR account_type = 'ADMIN' "
    "THEN 'admin' ELSE username END FROM users WHERE id = %s"
)

# SQL predicate selecting every user id holding admin rights.
ADMIN_USER_IDS_SUBQUERY = (
    "SELECT id FROM users WHERE username = 'admin' OR account_type = 'ADMIN'"
)


def get_admin_flags(db_manager, user_id):
    """Return (username, is_admin, is_super_admin) for ``user_id``."""
    row = db_manager.execute_query(
        'SELECT username, account_type FROM users WHERE id = %s',
        (user_id,), fetch_one=True
    )
    if not row:
        return '', False, False
    username, account_type = row[0], row[1]
    is_super = username == SUPER_ADMIN_USERNAME
    return username, is_super or account_type == ADMIN_ACCOUNT_TYPE, is_super
