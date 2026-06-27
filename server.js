// Force the native dotenv path initialization to ignore external tool injectors
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express(); // Keeping your express architecture
app.use(express.json());
app.use(cors());

// Purely environment-driven pool config
const pool = new Pool({
  user: process.env.APP_DB_USER,        // 👈 Added APP_
  host: process.env.APP_DB_HOST,        // 👈 Added APP_
  database: process.env.APP_DB_NAME,    // 👈 Added APP_
  password: process.env.APP_DB_PASSWORD,// 👈 Added APP_
  port: parseInt(process.env.APP_DB_PORT) || 5432, // 👈 Added APP_
});

const PORT = process.env.PORT || 5000;

const initializeDatabase = async () => {
    try {
        await pool.query("BEGIN");

        // 1. Core items table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS items (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE,
                quantity INTEGER NOT NULL DEFAULT 0,
                cost_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
                sale_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00
            );
        `);

        // 2. Bundle relationship configuration structure
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bundle_items (
                bundle_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
                component_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
                quantity_needed INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (bundle_id, component_id)
            );
        `);

        // 3. Financial ledger tracking logs
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inventory_log (
                id SERIAL PRIMARY KEY,
                item_id INTEGER NOT NULL,
                item_name VARCHAR(255) NOT NULL,
                movement_type VARCHAR(10) NOT NULL, -- 'IN' or 'OUT'
                quantity_changed INTEGER NOT NULL,
                sold_at_sale_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
                captured_cost_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
                log_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query("COMMIT");
        console.log('✅ Database tables initialized successfully with split pricing constraints.');
    } catch (err) {
        await pool.query("ROLLBACK");
        console.error('❌ Database Initialization Error:', err.message);
    }
};
initializeDatabase();

app.use(express.static(path.join(__dirname, 'public')));

// GET: Fetch all active items
app.get('/api/items', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM items ORDER BY id ASC");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST: Restock item from Alibaba (Recalculates Weighted Average Cost Price)
app.post('/api/items', async (req, res) => {
    const { name, quantity, buy_price } = req.body;
    const incomingQty = parseInt(quantity);
    const incomingBuyPrice = parseFloat(buy_price);

    try {
        const checkItem = await pool.query("SELECT * FROM items WHERE LOWER(name) = LOWER($1)", [name.trim()]);
        let item;

        if (checkItem.rows.length > 0) {
            const existing = checkItem.rows[0];
            const currentQty = existing.quantity;
            const currentCost = parseFloat(existing.cost_price || 0);

            const newQty = currentQty + incomingQty;

            // Compute Weighted Average Cost for items coming from Alibaba
            let newWeightedCost = incomingBuyPrice;
            if (newQty > 0) {
                newWeightedCost = ((currentQty * currentCost) + (incomingQty * incomingBuyPrice)) / newQty;
            }
            newWeightedCost = Math.round(newWeightedCost * 100) / 100;

            const result = await pool.query(
                "UPDATE items SET quantity = $1, cost_price = $2 WHERE id = $3 RETURNING *",
                [newQty, newWeightedCost, existing.id]
            );
            item = result.rows[0];
        } else {
            const result = await pool.query(
                "INSERT INTO items (name, quantity, cost_price, sale_price) VALUES ($1, $2, $3, $4) RETURNING *",
                [name.trim(), incomingQty, incomingBuyPrice, incomingBuyPrice]
            );
            item = result.rows[0];
        }

        // Log transaction ingestion
        await pool.query(
            "INSERT INTO inventory_log (item_id, item_name, movement_type, quantity_changed, sold_at_sale_price, captured_cost_price) VALUES ($1, $2, $3, $4, $5, $6)",
            [item.id, item.name, 'IN', incomingQty, 0, incomingBuyPrice]
        );

        res.json(item);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT: Modify local selling price in Armenia
app.put('/api/items/:id/sale-price', async (req, res) => {
    const { id } = req.params;
    const { sale_price } = req.body;

    try {
        if (sale_price === undefined || isNaN(sale_price) || parseFloat(sale_price) < 0) {
            return res.status(400).json({ error: "Please provide a valid selling price numeric value." });
        }

        const result = await pool.query(
            "UPDATE items SET sale_price = $1 WHERE id = $2 RETURNING *",
            [parseFloat(sale_price), id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Target item was not discovered in warehouse records." });
        }

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST: Log Sale (Deducts child stock, but logs finances based ONLY on Parent Set A)
app.post('/api/sales', async (req, res) => {
    const { item_id, quantity_sold } = req.body;
    const qty = parseInt(quantity_sold);

    try {
        await pool.query("BEGIN");

        const itemRes = await pool.query("SELECT * FROM items WHERE id = $1", [item_id]);
        const mainItem = itemRes.rows[0];
        if (!mainItem) {
            await pool.query("ROLLBACK");
            return res.status(404).json({ error: "Item not found" });
        }

        const componentsRes = await pool.query(`
            SELECT bi.component_id, bi.quantity_needed, i.name, i.quantity as stock
            FROM bundle_items bi
            JOIN items i ON bi.component_id = i.id
            WHERE bi.bundle_id = $1
        `, [item_id]);

        const isBundle = componentsRes.rows.length > 0;

        if (isBundle) {
            const components = componentsRes.rows;

            for (let comp of components) {
                const totalNeeded = comp.quantity_needed * qty;
                if (comp.stock < totalNeeded) {
                    await pool.query("ROLLBACK");
                    return res.status(400).json({
                        error: `Not enough stock for component: "${comp.name}"! Need ${totalNeeded}, but only have ${comp.stock} available.`
                    });
                }
            }

            for (let comp of components) {
                const totalNeeded = comp.quantity_needed * qty;
                await pool.query("UPDATE items SET quantity = quantity - $1 WHERE id = $2", [totalNeeded, comp.component_id]);
            }

        } else {
            if (mainItem.quantity < qty) {
                await pool.query("ROLLBACK");
                return res.status(400).json({ error: "Not enough stock!" });
            }
            await pool.query("UPDATE items SET quantity = quantity - $1 WHERE id = $2", [qty, item_id]);
        }

        await pool.query(
            `INSERT INTO inventory_log (item_id, item_name, movement_type, quantity_changed, sold_at_sale_price, captured_cost_price)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [mainItem.id, mainItem.name, 'OUT', qty, mainItem.sale_price, mainItem.cost_price]
        );

        await pool.query("COMMIT");
        res.json({ message: "Sale processed successfully", isBundle });
    } catch (err) {
        await pool.query("ROLLBACK");
        res.status(500).json({ error: err.message });
    }
});

// GET: Fetch detailed summary metrics (Revenue, Cost, Pure Net Margins)
app.get('/api/sales/daily-total', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                SUM(quantity_changed * sold_at_sale_price) as total_revenue,
                SUM(quantity_changed * captured_cost_price) as total_cost
            FROM inventory_log
            WHERE movement_type = 'OUT' AND log_date >= CURRENT_DATE
        `);

        const revenue = parseFloat(result.rows[0].total_revenue || 0);
        const cost = parseFloat(result.rows[0].total_cost || 0);
        const pure_profit = revenue - cost;

        res.json({ revenue, cost, pure_profit });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET: Monthly high-level bookkeeping archive overview
app.get('/api/sales/history', async (req, res) => {
    try {
        const query = `
            SELECT TO_CHAR(log_date, 'YYYY-MM') as date,
                   SUM(quantity_changed * sold_at_sale_price) - SUM(quantity_changed * captured_cost_price) as daily_profit
            FROM inventory_log
            WHERE movement_type = 'OUT'
            GROUP BY TO_CHAR(log_date, 'YYYY-MM')
            ORDER BY date DESC;
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET: Fetch all unique days that have activity inside a specific month
app.get('/api/reports/months/:month/days', async (req, res) => {
    const { month } = req.params;
    try {
        const query = `
            SELECT DISTINCT TO_CHAR(log_date, 'YYYY-MM-DD') as active_date
            FROM inventory_log
            WHERE TO_CHAR(log_date, 'YYYY-MM') = $1
            ORDER BY active_date DESC;
        `;
        const result = await pool.query(query, [month]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET: Itemized Breakdown for an Entire Year
app.get('/api/reports/year/:year', async (req, res) => {
    const { year } = req.params;
    try {
        const query = `
            SELECT item_name as name,
                   SUM(CASE WHEN movement_type = 'IN' THEN quantity_changed ELSE 0 END) as total_ins,
                   SUM(CASE WHEN movement_type = 'OUT' THEN quantity_changed ELSE 0 END) as total_outs,
                   SUM(CASE WHEN movement_type = 'OUT' THEN (quantity_changed * sold_at_sale_price) - (quantity_changed * captured_cost_price) ELSE 0 END) as calculated_profit
            FROM inventory_log
            WHERE TO_CHAR(log_date, 'YYYY') = $1
            GROUP BY item_name ORDER BY name ASC;
        `;
        const result = await pool.query(query, [year]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET: Itemized Breakdown for an Entire Month
app.get('/api/reports/month/:month', async (req, res) => {
    const { month } = req.params;
    try {
        const query = `
            SELECT item_name as name,
                   SUM(CASE WHEN movement_type = 'IN' THEN quantity_changed ELSE 0 END) as total_ins,
                   SUM(CASE WHEN movement_type = 'OUT' THEN quantity_changed ELSE 0 END) as total_outs,
                   SUM(CASE WHEN movement_type = 'OUT' THEN (quantity_changed * sold_at_sale_price) - (quantity_changed * captured_cost_price) ELSE 0 END) as calculated_profit
            FROM inventory_log
            WHERE TO_CHAR(log_date, 'YYYY-MM') = $1
            GROUP BY item_name ORDER BY name ASC;
        `;
        const result = await pool.query(query, [month]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET: Itemized Breakdown for a Single Day
app.get('/api/reports/day/:date', async (req, res) => {
    const { date } = req.params;
    try {
        const query = `
            SELECT item_name as name,
                   SUM(CASE WHEN movement_type = 'IN' THEN quantity_changed ELSE 0 END) as total_ins,
                   SUM(CASE WHEN movement_type = 'OUT' THEN quantity_changed ELSE 0 END) as total_outs,
                   SUM(CASE WHEN movement_type = 'OUT' THEN (quantity_changed * sold_at_sale_price) - (quantity_changed * captured_cost_price) ELSE 0 END) as calculated_profit
            FROM inventory_log
            WHERE TO_CHAR(log_date, 'YYYY-MM-DD') = $1
            GROUP BY item_name ORDER BY name ASC;
        `;
        const result = await pool.query(query, [date]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE: Remove an item from the warehouse catalog
app.delete('/api/items/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM items WHERE id = $1", [id]);
        res.json({ message: "Deleted successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST: Create a bundle relationship
app.post('/api/bundles', async (req, res) => {
    const { bundle_id, components } = req.body;
    try {
        await pool.query("BEGIN");

        for (let comp of components) {
            await pool.query(
                `INSERT INTO bundle_items (bundle_id, component_id, quantity_needed)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (bundle_id, component_id)
                 DO UPDATE SET quantity_needed = EXCLUDED.quantity_needed`,
                [bundle_id, comp.id, comp.qty]
            );
        }

        await pool.query("COMMIT");
        res.json({ success: true, message: "Bundle mapping linked successfully!" });
    } catch (err) {
        await pool.query("ROLLBACK");
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
