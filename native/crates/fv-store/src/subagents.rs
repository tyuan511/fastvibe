use crate::{Db, StoreError};
use fv_protocol::{
    subagents::{Subagent, SubagentStatus},
    types::Thread,
};
use rusqlite::{OptionalExtension, params};

impl Db {
    /// Link and child catalog entry are one transaction: a child never leaks into chat lists.
    pub fn create_subagent(&self, thread: &Thread, agent: &Subagent) -> Result<(), StoreError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO conversations (id, updated_at, archived, data) VALUES (?1, ?2, ?3, ?4)",
            params![
                thread.id,
                thread.updated_at,
                thread.archived,
                serde_json::to_string(thread)?
            ],
        )?;
        tx.execute(
            "INSERT INTO subagents (agent_id, parent_id, root_id, data) VALUES (?1, ?2, ?3, ?4)",
            params![
                agent.agent_id,
                agent.parent_thread_id,
                agent.root_thread_id,
                serde_json::to_string(agent)?
            ],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn subagent(&self, id: &str) -> Result<Option<Subagent>, StoreError> {
        let data: Option<String> = self
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT data FROM subagents WHERE agent_id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        data.map(|s| serde_json::from_str(&s).map_err(StoreError::from))
            .transpose()
    }
    pub fn subagents(&self, root: Option<&str>) -> Result<Vec<Subagent>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT data FROM subagents WHERE (?1 IS NULL OR root_id = ?1) ORDER BY rowid",
        )?;
        stmt.query_map([root], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect()
    }
    /// Bounded global list for a client with no conversation selected.
    pub fn recent_subagents(&self) -> Result<Vec<Subagent>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT data FROM subagents ORDER BY rowid DESC LIMIT 100")?;
        stmt.query_map([], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect()
    }
    /// Updates cannot recreate a child that was deleted while its turn was settling.
    pub fn update_subagent(&self, agent: &Subagent) -> Result<(), StoreError> {
        self.conn.lock().unwrap().execute(
            "UPDATE subagents SET data = ?2 WHERE agent_id = ?1",
            params![agent.agent_id, serde_json::to_string(agent)?],
        )?;
        Ok(())
    }
    /// Unfinished runs are never silently restarted (their tools may already have written).
    pub fn recover_subagents(&self) -> Result<(), StoreError> {
        for mut agent in self.subagents(None)? {
            if agent.status == SubagentStatus::Running {
                agent.status = SubagentStatus::Interrupted;
                agent.error =
                    Some("The server stopped during this run. Send new input to continue.".into());
                self.update_subagent(&agent)?;
            }
        }
        Ok(())
    }
}
