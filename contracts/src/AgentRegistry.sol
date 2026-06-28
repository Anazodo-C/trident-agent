// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract AgentRegistry is ERC721URIStorage, Ownable, ReentrancyGuard {
    uint256 private _nextAgentId = 1;

    enum AgentType { BUYER, SELLER, BOTH, RETROBOT }
    enum AgentStatus { ACTIVE, SUSPENDED, DEREGISTERED }

    struct AgentProfile {
        uint256 agentId;
        address owner;
        AgentType agentType;
        AgentStatus status;
        uint256 reputationScore;
        uint256 totalJobs;
        uint256 successfulJobs;
        uint256 failedJobs;
        uint256 totalEarned;
        uint256 totalSpent;
        uint256 registeredAt;
        uint256 lastActiveAt;
        bool isRetrobot;
        string serviceEndpoint;
        string[] serviceTypes;
    }

    struct ReputationEvent {
        uint256 agentId;
        int256 scoreDelta;
        string reason;
        address reportedBy;
        uint256 timestamp;
    }

    mapping(uint256 => AgentProfile) public agents;
    mapping(address => uint256) public addressToAgentId;
    mapping(uint256 => ReputationEvent[]) public reputationHistory;
    mapping(address => bool) public authorisedSlashers;

    uint256 public totalAgents;
    uint256 public constant MAX_REPUTATION = 10000;
    uint256 public constant INITIAL_REPUTATION = 5000;

    event AgentRegistered(
        uint256 indexed agentId,
        address indexed owner,
        AgentType agentType,
        string serviceEndpoint
    );
    event ReputationUpdated(uint256 indexed agentId, uint256 oldScore, uint256 newScore, string reason);

    modifier onlySlasher() {
        require(authorisedSlashers[msg.sender], "Not authorised slasher");
        _;
    }

    modifier agentExists(uint256 agentId) {
        require(agentId > 0 && agentId < _nextAgentId, "Agent does not exist");
        _;
    }

    constructor(address initialOwner) ERC721("TridentAgent", "TAGENT") Ownable(initialOwner) {}

    function registerAgent(
        AgentType agentType,
        string calldata agentCardURI,
        string calldata serviceEndpoint,
        string[] calldata serviceTypes
    ) external nonReentrant returns (uint256 agentId) {
        require(addressToAgentId[msg.sender] == 0, "Already registered");
        agentId = _nextAgentId++;
        totalAgents++;
        agents[agentId] = AgentProfile({
            agentId: agentId,
            owner: msg.sender,
            agentType: agentType,
            status: AgentStatus.ACTIVE,
            reputationScore: INITIAL_REPUTATION,
            totalJobs: 0,
            successfulJobs: 0,
            failedJobs: 0,
            totalEarned: 0,
            totalSpent: 0,
            registeredAt: block.timestamp,
            lastActiveAt: block.timestamp,
            isRetrobot: false,
            serviceEndpoint: serviceEndpoint,
            serviceTypes: serviceTypes
        });
        addressToAgentId[msg.sender] = agentId;
        _mint(msg.sender, agentId);
        _setTokenURI(agentId, agentCardURI);
        emit AgentRegistered(agentId, msg.sender, agentType, serviceEndpoint);
    }

    function recordJobCompletion(uint256 agentId, bool success, uint256 tridAmount, bool isSeller)
        external onlySlasher agentExists(agentId)
    {
        AgentProfile storage agent = agents[agentId];
        agent.totalJobs++;
        agent.lastActiveAt = block.timestamp;
        if (success) {
            agent.successfulJobs++;
            if (isSeller) agent.totalEarned += tridAmount;
            else agent.totalSpent += tridAmount;
            uint256 newScore = agent.reputationScore + 10;
            if (newScore > MAX_REPUTATION) newScore = MAX_REPUTATION;
            _updateReputation(agentId, newScore, "Successful job completion");
        } else {
            agent.failedJobs++;
            uint256 slash = 200;
            uint256 newScore = agent.reputationScore > slash ? agent.reputationScore - slash : 0;
            _updateReputation(agentId, newScore, "Job failure");
        }
    }

    function slashReputation(uint256 agentId, uint256 slashAmount, string calldata reason)
        external onlySlasher agentExists(agentId)
    {
        uint256 newScore = agents[agentId].reputationScore > slashAmount
            ? agents[agentId].reputationScore - slashAmount
            : 0;
        _updateReputation(agentId, newScore, reason);
    }

    function rewardReputation(uint256 agentId, uint256 rewardAmount, string calldata reason)
        external onlySlasher agentExists(agentId)
    {
        uint256 newScore = agents[agentId].reputationScore + rewardAmount;
        if (newScore > MAX_REPUTATION) newScore = MAX_REPUTATION;
        _updateReputation(agentId, newScore, reason);
    }

    function _updateReputation(uint256 agentId, uint256 newScore, string memory reason) internal {
        uint256 oldScore = agents[agentId].reputationScore;
        agents[agentId].reputationScore = newScore;
        reputationHistory[agentId].push(ReputationEvent({
            agentId: agentId,
            scoreDelta: int256(newScore) - int256(oldScore),
            reason: reason,
            reportedBy: msg.sender,
            timestamp: block.timestamp
        }));
        emit ReputationUpdated(agentId, oldScore, newScore, reason);
    }

    function getAgent(uint256 agentId) external view agentExists(agentId) returns (AgentProfile memory) {
        return agents[agentId];
    }

    function getAgentByAddress(address wallet) external view returns (AgentProfile memory) {
        uint256 agentId = addressToAgentId[wallet];
        require(agentId != 0, "Address not registered");
        return agents[agentId];
    }

    function addSlasher(address slasher) external onlyOwner { authorisedSlashers[slasher] = true; }
    function removeSlasher(address slasher) external onlyOwner { authorisedSlashers[slasher] = false; }
}
