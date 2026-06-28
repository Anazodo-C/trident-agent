// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./AgentRegistry.sol";

contract ReputationBond is Ownable, ReentrancyGuard {
    IERC20 public immutable trid;
    AgentRegistry public immutable registry;

    struct Bond {
        address agent;
        uint256 totalBonded;
        uint256 availableBond;
        uint256 totalSlashed;
        uint256 slashCount;
        uint256 bondedAt;
        bool active;
    }

    mapping(address => Bond) public bonds;
    uint256 public minimumBond = 5 * 1e6;
    address public retrobot;
    address public escrow;
    uint256 public totalBondedInSystem;
    uint256 public totalSlashedInSystem;

    event BondPosted(address indexed agent, uint256 amount, uint256 totalBonded);
    event BondSlashed(address indexed agent, uint256 slashAmount, address indexed recipient, string reason);
    event BondWithdrawn(address indexed agent, uint256 amount);

    modifier onlyAuthorised() {
        require(msg.sender == retrobot || msg.sender == escrow, "Not authorised");
        _;
    }

    constructor(address initialOwner, address _trid, address _registry) Ownable(initialOwner) {
        trid = IERC20(_trid);
        registry = AgentRegistry(_registry);
    }

    function postBond(uint256 amount) external nonReentrant {
        require(amount >= minimumBond, "Below minimum bond");
        require(registry.addressToAgentId(msg.sender) != 0, "Must register as agent first");
        require(trid.transferFrom(msg.sender, address(this), amount), "Transfer failed");
        Bond storage bond = bonds[msg.sender];
        if (!bond.active) {
            bonds[msg.sender] = Bond({
                agent: msg.sender,
                totalBonded: amount,
                availableBond: amount,
                totalSlashed: 0,
                slashCount: 0,
                bondedAt: block.timestamp,
                active: true
            });
        } else {
            bond.totalBonded += amount;
            bond.availableBond += amount;
        }
        totalBondedInSystem += amount;
        uint256 agentId = registry.addressToAgentId(msg.sender);
        registry.rewardReputation(agentId, 50, "Reputation bond posted");
        emit BondPosted(msg.sender, amount, bonds[msg.sender].totalBonded);
    }

    function slash(address agent, uint256 slashAmount, address recipient, string calldata reason)
        external onlyAuthorised nonReentrant
    {
        Bond storage bond = bonds[agent];
        require(bond.active, "No active bond");
        uint256 actualSlash = slashAmount > bond.availableBond ? bond.availableBond : slashAmount;
        bond.availableBond -= actualSlash;
        bond.totalSlashed += actualSlash;
        bond.slashCount++;
        totalSlashedInSystem += actualSlash;
        if (bond.availableBond == 0) bond.active = false;
        require(trid.transfer(recipient, actualSlash), "Slash transfer failed");
        uint256 agentId = registry.addressToAgentId(agent);
        if (agentId != 0) registry.slashReputation(agentId, 500, reason);
        emit BondSlashed(agent, actualSlash, recipient, reason);
    }

    function withdrawBond(uint256 amount) external nonReentrant {
        Bond storage bond = bonds[msg.sender];
        require(bond.active, "No active bond");
        require(amount <= bond.availableBond, "Insufficient available bond");
        bond.availableBond -= amount;
        bond.totalBonded -= amount;
        totalBondedInSystem -= amount;
        if (bond.availableBond == 0) bond.active = false;
        require(trid.transfer(msg.sender, amount), "Withdrawal failed");
        emit BondWithdrawn(msg.sender, amount);
    }

    function getBond(address agent) external view returns (Bond memory) { return bonds[agent]; }

    function hasBond(address agent) external view returns (bool) {
        return bonds[agent].active && bonds[agent].availableBond >= minimumBond;
    }

    function getBondTier(address agent) external view returns (string memory) {
        uint256 available = bonds[agent].availableBond;
        if (available >= 100 * 1e6) return "Elite";
        if (available >= 50 * 1e6) return "Premium";
        if (available >= 20 * 1e6) return "Verified";
        if (available >= minimumBond) return "Basic";
        return "Unbonded";
    }

    function setRetrobot(address _retrobot) external onlyOwner { retrobot = _retrobot; }
    function setEscrow(address _escrow) external onlyOwner { escrow = _escrow; }
}
