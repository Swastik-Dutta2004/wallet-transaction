const express = require("express")
const {registration} = require("../controllers/auth.controllers")

const router = express.Router()

router.post("/registration", registration)

module.exports = router